// Package resolver is the public QR contact resolver (helix-qr/1).
//
// It is deliberately UNTRUSTED FOR CONTENT. It holds no signing key. It stores
// resolutions that the issuer signed, serves them, and refuses to serve anything
// that does not verify. A compromised resolver can therefore withhold a contact
// or serve a stale one (which clients reject by `fresh_until`), but it cannot
// forge a contact: every client re-verifies the signatures itself.
//
// Before it hands out anything it verifies, in this order: the reference's
// structure, hash and issuer signature (trusted anchors only); the domain
// binding (the reference must name THIS resolver, and the request must have
// arrived for this host); the reference's expiry; then, on the stored
// resolution, that it answers this reference, was signed by its issuer, is
// current, and reports its status.
package resolver

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/qr"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/ratelimit"
)

const maxPublishBody = 256 << 10

type Config struct {
	// Origin is this resolver's public origin, e.g. https://contact.example.
	Origin string
	Trust  *qr.Trust
	Store  Store
	// PublishTokenSHA256 is the hex SHA-256 of the bearer token allowed to
	// publish. Empty disables publishing.
	PublishTokenSHA256 string
	Now                func() time.Time
	Log                *slog.Logger
	RatePerSec         float64
	Burst              int
}

type Server struct {
	origin, host string
	trust        *qr.Trust
	store        Store
	tokenHash    []byte
	now          func() time.Time
	log          *slog.Logger
	limiter      *ratelimit.Limiter
}

func New(c Config) (*Server, error) {
	if p := qr.OriginProblem(c.Origin); p != "" {
		return nil, errors.New("resolver origin: " + p)
	}
	if c.Trust == nil || len(c.Trust.Issuers) == 0 {
		return nil, errors.New("a resolver without trust anchors can verify nothing")
	}
	if c.Store == nil {
		return nil, errors.New("a store is required")
	}
	s := &Server{origin: c.Origin, host: strings.TrimPrefix(c.Origin, "https://"), trust: c.Trust, store: c.Store, now: c.Now, log: c.Log}
	if s.now == nil {
		s.now = time.Now
	}
	if s.log == nil {
		s.log = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	if c.PublishTokenSHA256 != "" {
		h, err := hex.DecodeString(c.PublishTokenSHA256)
		if err != nil || len(h) != sha256.Size {
			return nil, errors.New("publish token hash must be 64 hex characters")
		}
		s.tokenHash = h
	}
	rate, burst := c.RatePerSec, c.Burst
	if rate <= 0 {
		rate = 20
	}
	if burst <= 0 {
		burst = 60
	}
	s.limiter = ratelimit.New(rate, burst)
	s.limiter.SetClock(s.now)
	return s, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /q/{payload}", s.resolve)
	mux.HandleFunc("OPTIONS /q/{payload}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("PUT /v1/publish", s.publish)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { writeError(w, 404, "not_found", "no such endpoint") })
	return s.recoverer(mux)
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("panic", "panic", v)
				writeError(w, 500, "internal", "internal error")
			}
		}()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(append(b, '\n'))
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func nowString(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

func has(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host // X-Forwarded-For is a claim, not a fact
}

// ── GET /q/{payload} ─────────────────────────────────────────────────────────

func (s *Server) resolve(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.limiter.Allow("ip:" + clientIP(r)); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, 429, "rate_limited", "slow down")
		return
	}
	// The request must have been addressed to this resolver. A reference that
	// was re-hosted behind someone else's name, or a rebinding trick, stops here.
	if !strings.EqualFold(r.Host, s.host) {
		writeError(w, 421, "misdirected", "this resolver does not serve that host")
		return
	}
	if r.URL.RawQuery != "" {
		writeError(w, 400, "invalid_reference", "a QR reference takes no query string")
		return
	}
	now := nowString(s.now())
	wire := s.origin + "/q/" + r.PathValue("payload")
	ref, rv := qr.VerifyReference(wire, s.trust, now)
	switch {
	case !rv.OK:
		writeError(w, 400, "invalid_reference", rv.Errors[0])
		return
	case has(rv.Untrusted, "has expired"):
		writeError(w, 410, "expired", "this QR code has expired")
		return
	case !rv.Trusted:
		// Unknown issuer, key out of its window, not yet valid: not something to serve a contact for.
		s.log.Info("reference not trusted", "untrusted", rv.Untrusted)
		writeError(w, 404, "not_found", "no such contact")
		return
	}

	raw, err := s.store.Get(ref.Hash)
	if errors.Is(err, ErrNotFound) {
		writeError(w, 404, "not_found", "no such contact")
		return
	} else if err != nil {
		s.log.Error("store", "error", err.Error())
		writeError(w, 503, "unavailable", "the contact store is unavailable")
		return
	}
	res, status, fresh, ok := s.checkStored(raw, ref, now)
	if !ok {
		w.Header().Set("Retry-After", "30")
		writeError(w, 503, "resolution_unavailable", "no current, verified resolution is available for this contact")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*") // public data, GET only
	code := http.StatusOK
	if status == "active" {
		left := int(fresh.Sub(s.now()).Seconds())
		if left > 300 {
			left = 300
		}
		w.Header().Set("Cache-Control", "public, max-age="+strconv.Itoa(left))
	} else {
		code = http.StatusGone // revoked, suspended, superseded: the signed document says so
		w.Header().Set("Cache-Control", "no-store")
	}
	w.WriteHeader(code)
	_, _ = w.Write(res)
}

// checkStored re-verifies a stored resolution before it is served. It returns
// the bytes to serve, its status, its freshness deadline, and whether it may be served.
func (s *Server) checkStored(raw []byte, ref *qr.Reference, now string) ([]byte, string, time.Time, bool) {
	v, err := qr.DecodeJSON(raw)
	doc, isObj := v.(map[string]any)
	if err != nil || !isObj {
		s.log.Error("stored resolution is not a JSON object", "ref", ref.Hash)
		return nil, "", time.Time{}, false
	}
	ev := qr.CheckEnvelope(doc, ref, s.trust, now, s.origin)
	status, _ := doc["status"].(string)
	if !ev.OK {
		s.log.Error("stored resolution does not verify", "ref", ref.Hash, "errors", ev.Errors)
		return nil, "", time.Time{}, false
	}
	for _, u := range ev.Untrusted {
		if !strings.HasPrefix(u, "the contact is ") { // stale, not valid yet, unanchored key...
			s.log.Warn("stored resolution is not servable", "ref", ref.Hash, "untrusted", ev.Untrusted)
			return nil, "", time.Time{}, false
		}
	}
	fresh, _ := time.Parse("2006-01-02T15:04:05Z", doc["fresh_until"].(string))
	return raw, status, fresh, true
}

// ── PUT /v1/publish ──────────────────────────────────────────────────────────

type publishRequest struct {
	Reference  string          `json:"reference"`
	Resolution json.RawMessage `json:"resolution"`
}

func terminal(status string) bool { return status == "revoked" || status == "superseded" }

// Accept decides whether `next` may replace `stored` (nil when there is none).
// Resolutions only move forward: a newer issued_at wins; at the same instant
// only a terminal status (revocation) may replace a non-terminal one; and a
// revoked or superseded reference never becomes active again.
func Accept(stored, next map[string]any) error {
	if stored == nil {
		return nil
	}
	oldStatus, _ := stored["status"].(string)
	newStatus, _ := next["status"].(string)
	oldAt, _ := stored["issued_at"].(string)
	newAt, _ := next["issued_at"].(string)
	oldHash, _ := stored["hash"].(string)
	newHash, _ := next["hash"].(string)
	switch {
	case oldHash == newHash:
		return nil // the same document again
	case terminal(oldStatus) && !terminal(newStatus):
		return errors.New("a revoked or superseded contact cannot be reactivated: issue a new QR code")
	case newAt < oldAt:
		return errors.New("older than the stored resolution")
	case newAt == oldAt && !(terminal(newStatus) && !terminal(oldStatus)):
		return errors.New("a different resolution for the same instant")
	}
	return nil
}

func (s *Server) publish(w http.ResponseWriter, r *http.Request) {
	if s.tokenHash == nil {
		writeError(w, 503, "publishing_disabled", "publishing is not configured")
		return
	}
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	if !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare(sum[:], s.tokenHash) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="helix-resolver"`)
		writeError(w, 401, "unauthenticated", "a valid publish token is required")
		return
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeError(w, 415, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPublishBody))
	if err != nil {
		writeError(w, 413, "too_large", "body is larger than 256 KiB")
		return
	}
	var req publishRequest
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || req.Reference == "" || len(req.Resolution) == 0 {
		writeError(w, 400, "invalid_request", "body must be {reference, resolution}")
		return
	}
	if _, err := dec.Token(); err != io.EOF {
		writeError(w, 400, "invalid_request", "body must be exactly one JSON document")
		return
	}

	now := nowString(s.now())
	ref, rv := qr.VerifyReference(req.Reference, s.trust, now)
	if !rv.Trusted {
		writeError(w, 422, "invalid_reference", firstProblem(rv))
		return
	}
	if ref.Resolver != s.origin {
		writeError(w, 422, "wrong_resolver", "the reference names another resolver")
		return
	}
	v, err := qr.DecodeJSON(req.Resolution)
	doc, isObj := v.(map[string]any)
	if err != nil || !isObj {
		writeError(w, 400, "invalid_request", "resolution must be a JSON object")
		return
	}
	ev := qr.CheckEnvelope(doc, ref, s.trust, now, s.origin)
	if !ev.OK {
		writeError(w, 422, "invalid_resolution", ev.Errors[0])
		return
	}
	for _, u := range ev.Untrusted {
		if !strings.HasPrefix(u, "the contact is ") {
			writeError(w, 422, "invalid_resolution", u)
			return
		}
	}

	var stored map[string]any
	if old, err := s.store.Get(ref.Hash); err == nil {
		if ov, derr := qr.DecodeJSON(old); derr == nil {
			stored, _ = ov.(map[string]any)
		}
	} else if !errors.Is(err, ErrNotFound) {
		writeError(w, 503, "unavailable", "the contact store is unavailable")
		return
	}
	if err := Accept(stored, doc); err != nil {
		writeError(w, 409, "conflict", err.Error())
		return
	}
	if err := s.store.Put(ref.Hash, req.Resolution); err != nil {
		s.log.Error("store", "error", err.Error())
		writeError(w, 503, "unavailable", "the contact store is unavailable")
		return
	}
	s.log.Info("published", "ref", ref.Hash, "status", doc["status"])
	writeJSON(w, 200, map[string]any{"stored": true, "reference_hash": ref.Hash, "status": doc["status"], "fresh_until": doc["fresh_until"]})
}

func firstProblem(v *qr.Verdict) string {
	if len(v.Errors) > 0 {
		return v.Errors[0]
	}
	if len(v.Untrusted) > 0 {
		return v.Untrusted[0]
	}
	return "reference is not trusted"
}
