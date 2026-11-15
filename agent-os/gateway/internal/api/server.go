// Package api is the HELIX REST gateway in front of the kernel.
//
// It does four things and nothing else: authenticate the caller, decide whether
// that caller may use this endpoint (roles, ownership), translate REST/JSON to
// the kernel's gRPC contract, and translate the answer back. The caller's
// identity reaches the kernel only as the RequestContext this package builds
// from the AUTHENTICATED token. Nothing in a body or a header can set it.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/auth"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/metrics"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/ratelimit"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	maxBody        = 1 << 20
	kernelTimeout  = 10 * time.Second
	defaultRate    = 20.0
	defaultBurst   = 40
	defaultMaxLive = 256
)

// Config is everything a Server needs; tests replace Kernel, Now and the logger.
type Config struct {
	Kernel      kernelv1.KernelClient
	Auth        *auth.Holder
	Log         *slog.Logger
	Now         func() time.Time
	RatePerSec  float64
	Burst       int
	MaxInFlight int
	// Metrics receives the gateway's counters; nil means a private registry.
	Metrics *metrics.Registry
}

type Server struct {
	kernel  kernelv1.KernelClient
	auth    *auth.Holder
	log     *slog.Logger
	now     func() time.Time
	limiter *ratelimit.Limiter
	live    chan struct{}
	m       *metrics.Registry
}

func New(c Config) *Server {
	s := &Server{kernel: c.Kernel, auth: c.Auth, log: c.Log, now: c.Now, m: c.Metrics}
	if s.m == nil {
		s.m = metrics.New()
	}
	if s.log == nil {
		s.log = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	if s.now == nil {
		s.now = time.Now
	}
	rate, burst, live := c.RatePerSec, c.Burst, c.MaxInFlight
	if rate <= 0 {
		rate = defaultRate
	}
	if burst <= 0 {
		burst = defaultBurst
	}
	if live <= 0 {
		live = defaultMaxLive
	}
	s.limiter = ratelimit.New(rate, burst)
	s.limiter.SetClock(s.now)
	s.live = make(chan struct{}, live)
	s.registerScrape()
	return s
}

// Metrics is the registry this server writes to.
func (s *Server) Metrics() *metrics.Registry { return s.m }

// Handler is the whole gateway.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /v1/health", s.authed(s.health))
	mux.HandleFunc("POST /v1/actions/authorize", s.authed(s.authorize))
	mux.HandleFunc("GET /v1/actions/{pending_id}", s.authed(s.getPending))
	mux.HandleFunc("POST /v1/actions/{pending_id}/confirm", s.authed(s.confirm))
	mux.HandleFunc("POST /v1/executions/begin", s.authed(s.beginExecution))
	mux.HandleFunc("POST /v1/executions/{execution_id}/result", s.authed(s.recordResult))
	mux.HandleFunc("POST /v1/grants/{grant_id}/revoke", s.authed(s.revokeGrant))
	mux.HandleFunc("POST /v1/identities/verify", s.authed(s.verifyIdentity))
	mux.HandleFunc("GET /v1/plugins", s.authed(s.listPlugins))
	mux.HandleFunc("POST /v1/plugins", s.authed(s.installPlugin))
	mux.HandleFunc("DELETE /v1/plugins/{plugin_id}", s.authed(s.removePlugin))
	mux.HandleFunc("POST /v1/plugins/{plugin_id}/tools/{tool}/invoke", s.authed(s.invokePlugin))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
	return s.recoverer(s.requestID(s.stripPrivileged(s.limitInFlight(mux))))
}

// ── middleware ────────────────────────────────────────────────────────────────

type ctxKey int

const keyRequestID ctxKey = 1

func rid(ctx context.Context) string {
	id, _ := ctx.Value(keyRequestID).(string)
	return id
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("panic", "request_id", rid(r.Context()), "panic", v)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestID gives every request a gateway-chosen id, returned in X-Request-Id
// and sent to the kernel as the correlation id. A client-supplied one is ignored.
func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b [8]byte
		_, _ = rand.Read(b[:])
		id := "req_" + hex.EncodeToString(b[:])
		w.Header().Set("X-Request-Id", id)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), keyRequestID, id)))
	})
}

// privilegedHeaders are headers a reverse proxy or SSO layer might set to
// assert identity. The gateway believes none of them (identity comes from the
// token), and removes them so nothing behind it can either.
var privilegedHeaders = []string{
	"X-Org-Id", "X-Organization-Id", "X-Organisation-Id", "X-Principal", "X-Principal-Id", "X-Principal-Kind",
	"X-User", "X-User-Id", "X-User-Email", "X-Forwarded-User", "X-Forwarded-Email", "X-Authenticated-User",
	"X-Remote-User", "X-Auth-Request-User", "X-Auth-Request-Email", "X-Roles", "X-Role", "X-Tenant", "X-Tenant-Id",
	"X-Correlation-Id", "X-Request-Id",
}

func (s *Server) stripPrivileged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k := range r.Header {
			if strings.HasPrefix(strings.ToLower(k), "x-helix-") {
				r.Header.Del(k)
			}
		}
		for _, h := range privilegedHeaders {
			r.Header.Del(h)
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) limitInFlight(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.live <- struct{}{}:
			s.m.Add("helix_gateway_in_flight", "Requests being handled now.", 1)
			defer func() { <-s.live; s.m.Add("helix_gateway_in_flight", "Requests being handled now.", -1) }()
			next.ServeHTTP(w, r)
		default:
			s.m.Counter("helix_gateway_shed_total", "Requests refused because too many were in flight.", 1)
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "overloaded", "too many requests in flight")
		}
	})
}

// caller is what a handler gets: who is calling, and the registry that vouched.
type caller struct {
	P   *auth.Principal
	Reg *auth.Registry
}

func (s *Server) authed(h func(http.ResponseWriter, *http.Request, caller)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := s.now()
		route := r.Pattern // a registered pattern, never a client-chosen string
		defer func() {
			s.m.Counter("helix_gateway_requests_total", "Requests by route and status.", 1, "route", route, "status", strconv.Itoa(rw.status))
			s.m.Observe("helix_gateway_request_seconds", "Request latency by route.", s.now().Sub(start).Seconds(), "route", route)
		}()
		reg, err := s.auth.Current()
		if reg == nil {
			s.m.Counter("helix_gateway_auth_failures_total", "Authentication failures by reason.", 1, "reason", "registry_unavailable")
			s.log.Error("principal registry unavailable", "request_id", rid(r.Context()), "error", err)
			writeError(rw, http.StatusServiceUnavailable, "auth_unavailable", "authentication is unavailable")
			return
		}
		scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		var p *auth.Principal
		if strings.EqualFold(scheme, "Bearer") {
			p = reg.Authenticate(strings.TrimSpace(token), s.now())
		}
		if p == nil {
			reason := "invalid_token"
			if r.Header.Get("Authorization") == "" {
				reason = "missing_token"
			}
			s.m.Counter("helix_gateway_auth_failures_total", "Authentication failures by reason.", 1, "reason", reason)
			rw.Header().Set("WWW-Authenticate", `Bearer realm="helix"`)
			s.log.Info("unauthenticated", "request_id", rid(r.Context()), "path", r.URL.Path)
			writeError(rw, http.StatusUnauthorized, "unauthenticated", "a valid bearer token is required")
			return
		}
		if ok, wait := s.limiter.Allow(p.Org + "/" + p.ID); !ok {
			s.m.Counter("helix_gateway_rate_limited_total", "Requests refused by the per-principal rate limit.", 1)
			rw.Header().Set("Retry-After", retryAfter(wait))
			writeError(rw, http.StatusTooManyRequests, "rate_limited", "slow down")
			return
		}
		h(rw, r, caller{P: p, Reg: reg})
		s.log.Info("request", "request_id", rid(r.Context()), "method", r.Method, "route", r.Pattern,
			"org", p.Org, "principal", p.ID, "kind", string(p.Kind), "status", rw.status, "ms", s.now().Sub(start).Milliseconds())
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func retryAfter(d time.Duration) string {
	return strconv.Itoa(int(d.Seconds()) + 1)
}

// ── request and response plumbing ─────────────────────────────────────────────

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status, b = http.StatusInternalServerError, []byte(`{"error":{"code":"internal","message":"internal error"}}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(append(b, '\n'))
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var e errorBody
	e.Error.Code, e.Error.Message = code, message
	writeJSON(w, status, e)
}

// decode reads exactly one JSON document of at most maxBody bytes, with no
// unknown fields. It writes the error response itself and reports whether the
// caller may continue.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeLimit(w, r, dst, maxBody)
}

// decodeLimit is decode with a body limit of the route's choosing (plugin
// components are uploaded whole).
func decodeLimit(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("body is larger than %d bytes", limit))
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request", "body is not the expected JSON: "+cleanJSONError(err))
		}
		return false
	}
	if _, err := dec.Token(); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be exactly one JSON document")
		return false
	}
	return true
}

func cleanJSONError(err error) string {
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

func (s *Server) kernelCtx(r *http.Request, p *auth.Principal) (context.Context, context.CancelFunc, *kernelv1.RequestContext) {
	ctx, cancel := context.WithTimeout(r.Context(), kernelTimeout)
	var kind kernelv1.PrincipalKind
	switch p.Kind {
	case auth.KindUser:
		kind = kernelv1.PrincipalKind_PRINCIPAL_KIND_USER
	case auth.KindService:
		kind = kernelv1.PrincipalKind_PRINCIPAL_KIND_SERVICE
	case auth.KindAgent:
		kind = kernelv1.PrincipalKind_PRINCIPAL_KIND_AGENT
	}
	return ctx, cancel, &kernelv1.RequestContext{CorrelationId: rid(r.Context()), OrganizationId: p.Org, Principal: p.ID, PrincipalKind: kind}
}

// upstream turns a kernel error into an HTTP error. The kernel's own messages
// are written for callers and pass through for the 4xx family; anything about
// the gateway's connection to the kernel is generic and logged instead.
func (s *Server) upstream(w http.ResponseWriter, r *http.Request, err error) {
	st, _ := status.FromError(err)
	var code int
	var name string
	pass := true
	switch st.Code() {
	case codes.InvalidArgument:
		code, name = http.StatusBadRequest, "invalid_request"
	case codes.PermissionDenied:
		code, name = http.StatusForbidden, "forbidden"
	case codes.NotFound:
		code, name = http.StatusNotFound, "not_found"
	case codes.FailedPrecondition, codes.AlreadyExists, codes.Aborted:
		code, name = http.StatusConflict, "conflict"
	case codes.ResourceExhausted:
		code, name = http.StatusTooManyRequests, "rate_limited"
	case codes.DeadlineExceeded:
		code, name, pass = http.StatusGatewayTimeout, "upstream_timeout", false
	case codes.Unavailable:
		code, name, pass = http.StatusServiceUnavailable, "upstream_unavailable", false
	default:
		code, name, pass = http.StatusBadGateway, "upstream_error", false
	}
	s.m.Counter("helix_gateway_upstream_errors_total", "Kernel errors by gRPC code.", 1, "grpc_code", st.Code().String())
	s.log.Info("kernel error", "request_id", rid(r.Context()), "grpc_code", st.Code().String(), "status", code)
	msg := "the kernel could not complete the request"
	if pass && st.Message() != "" {
		msg = st.Message()
	}
	writeError(w, code, name, msg)
}

func forbid(w http.ResponseWriter, why string) {
	writeError(w, http.StatusForbidden, "forbidden", why)
}

// registerScrape adds the gauges that are read at scrape time: whether the
// registry is valid and what the kernel says about itself.
func (s *Server) registerScrape() {
	s.m.OnScrape(func(m *metrics.Registry) {
		reg, _ := s.auth.Current()
		m.Gauge("helix_gateway_registry_ok", "1 when the principal registry is valid and loaded.", b2f(reg != nil))
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		h, err := s.kernel.Health(ctx, &kernelv1.HealthRequest{})
		m.Gauge("helix_kernel_up", "1 when the kernel answered a health probe.", b2f(err == nil))
		if err == nil {
			m.Gauge("helix_kernel_policy_available", "1 when the kernel can reach the policy service.", b2f(h.PolicyAvailable))
			m.Gauge("helix_kernel_audit_entries", "Entries in the kernel's audit chain.", float64(h.AuditEntries))
		}
	})
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
