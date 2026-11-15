// Package qr is the Go implementation of helix-qr/1 (spec: sid repo,
// spec/helix-qr-1.md): signed QR contact references and the signed resolutions a
// resolver serves for them.
//
// It implements what a RESOLVER needs: verifying a reference (structure, hash,
// issuer signature, domain binding, expiry) and checking a resolution's envelope
// (who signed it, which reference it answers, where it came from, whether it is
// current, what status it reports). It does NOT verify sid/0.2 certificates or
// runtime statements or build typed endpoints; that is the client's job (the
// Python and TypeScript implementations) and the resolver deliberately cannot
// vouch for it: a resolver is untrusted for content, so a compromised one can
// withhold or serve stale data but cannot forge a contact.
//
// Only Ed25519 issuer keys can be verified here. A BIP-340 issuer is reported as
// untrusted, never trusted, never an error.
//
// The shared vectors (testdata/vectors.json, from the sid repo) are the contract.
package qr

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/canonical"
)

const (
	Format           = "helix-qr/1"
	ResolutionFormat = "helix-qr-resolution/1"
	maxLifetime      = 400 * 24 * time.Hour
	maxFresh         = 24 * time.Hour
	skew             = 5 * time.Minute
)

var (
	statuses = map[string]bool{"active": true, "suspended": true, "revoked": true, "superseded": true}
	kinds    = map[string]bool{"agent": true, "business": true}

	refKeys = setOf("format", "kind", "sid", "card", "resolver", "domain", "issued_at", "expires_at", "nonce", "issuer", "hash", "proof")
	resKeys = setOf("format", "reference_hash", "resolver", "status", "superseded_by", "issued_at", "fresh_until",
		"certificate", "runtime", "card", "issuer", "hash", "proof")

	label     = `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`
	hostRe    = regexp.MustCompile(`^(?:` + label + `\.)+(?:[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z])$`)
	originRe  = regexp.MustCompile(`^https://([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$`)
	wireRe    = regexp.MustCompile(`^(https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?)/q/([A-Za-z0-9_-]+)$`)
	nonceRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	hex64     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hex128    = regexp.MustCompile(`^[0-9a-f]{128}$`)
	slugRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]*$`)
	sidRe     = regexp.MustCompile(`^sid_[a-z0-9][a-z0-9-]*$`)
	timeRe    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`)
	privateSx = []string{".local", ".localhost", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".private", ".localdomain"}
	secretKey = setOf("seed", "mnemonic", "private_key", "nsec", "secret", "secret_key")
)

func setOf(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, i := range items {
		m[i] = true
	}
	return m
}

// Verdict has the sid shape: OK (well-formed and untampered), Trusted (OK, anchored and current).
type Verdict struct {
	OK        bool
	Trusted   bool
	Errors    []string
	Untrusted []string
	Notes     []string
}

func (v *Verdict) finish() *Verdict {
	v.OK = len(v.Errors) == 0
	v.Trusted = v.OK && len(v.Untrusted) == 0
	return v
}

func (v *Verdict) errf(format string, a ...any) {
	v.Errors = append(v.Errors, fmt.Sprintf(format, a...))
}

// Reference is a parsed, verified-structure reference.
type Reference struct {
	Doc      map[string]any
	Hash     string
	Resolver string
	SID      string
}

// ── trust anchors (the sid/0.2 trust.json shape) ─────────────────────────────

type Key struct {
	Kid         string `json:"kid"`
	Alg         string `json:"alg"`
	PublicKey   string `json:"public_key"`
	NotBefore   string `json:"not_before"`
	NotAfter    string `json:"not_after"`
	RevokedAt   string `json:"revoked_at"`
	Compromised bool   `json:"compromised"`
}

type Trust struct {
	Issuers map[string]struct {
		Keys []Key `json:"keys"`
	} `json:"issuers"`
}

// ParseTrust reads a trust anchors document. nil in, nil out: no anchors.
func ParseTrust(raw []byte) (*Trust, error) {
	var t Trust
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	if t.Issuers == nil {
		return nil, errors.New("trust anchors need an \"issuers\" object")
	}
	return &t, nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

// DecodeJSON reads exactly one JSON document with numbers kept exact.
func DecodeJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing content after the JSON document")
	}
	return v, nil
}

func timeOK(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok || !timeRe.MatchString(s) {
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02T15:04:05Z", s)
	return t, err == nil && t.UTC().Format("2006-01-02T15:04:05Z") == s
}

func str(m map[string]any, k string) (string, bool) {
	s, ok := m[k].(string)
	return s, ok
}

// PublicHost: a name reachable on the public internet.
func PublicHost(host string) bool {
	if !hostRe.MatchString(host) || host == "localhost" {
		return false
	}
	for _, sfx := range privateSx {
		if strings.HasSuffix(host, sfx) {
			return false
		}
	}
	tld := host[strings.LastIndex(host, ".")+1:]
	for _, c := range tld {
		if c < '0' || c > '9' {
			return true
		}
	}
	return false
}

// OriginProblem says why v is not an acceptable resolver origin, or "".
func OriginProblem(v any) string {
	origin, ok := v.(string)
	if !ok {
		return "resolver must be a string"
	}
	m := originRe.FindStringSubmatch(origin)
	if m == nil {
		return "resolver must be an https origin: scheme and host, nothing else"
	}
	if !PublicHost(m[1]) {
		return "resolver must be a lowercase public DNS name, not an IP address, localhost or a private-use name"
	}
	if m[2] != "" {
		var p int
		fmt.Sscanf(m[2], "%d", &p)
		if p < 1 || p > 65535 || p == 443 || strings.HasPrefix(m[2], "0") {
			return "resolver has a bad or default port"
		}
	}
	return ""
}

func findSecrets(node any, path string) []string {
	var found []string
	switch t := node.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			here := k
			if path != "" {
				here = path + "." + k
			}
			if secretKey[k] {
				found = append(found, here)
			}
			found = append(found, findSecrets(t[k], here)...)
		}
	case []any:
		for i, v := range t {
			found = append(found, findSecrets(v, fmt.Sprintf("%s[%d]", path, i))...)
		}
	}
	return found
}

func unknownKeys(doc map[string]any, allowed map[string]bool) []string {
	var out []string
	for k := range doc {
		if !allowed[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func docHash(doc map[string]any) (string, error) { return canonical.HashWithout(doc, "hash", "proof") }

// issuerCheck mirrors sid/0.2's issuer authority rules for an Ed25519 proof.
func issuerCheck(doc map[string]any, trust *Trust, signedAt string, v *Verdict) {
	issuer, _ := doc["issuer"].(map[string]any)
	id, _ := str(issuer, "id")
	kid, _ := str(issuer, "kid")
	if issuer == nil || id == "" || kid == "" {
		v.errf("issuer must be {id, kid}")
		return
	}
	proof, _ := doc["proof"].(map[string]any)
	alg, _ := str(proof, "alg")
	sig, _ := str(proof, "signature")
	if proof == nil || (alg != "ed25519" && alg != "bip340") || !hex128.MatchString(sig) {
		v.errf("proof must be {alg, signature} with a supported alg and a 128-hex signature")
		return
	}
	if trust == nil {
		v.Untrusted = append(v.Untrusted, "no trust anchors supplied")
		return
	}
	anchor, ok := trust.Issuers[id]
	if !ok {
		v.Untrusted = append(v.Untrusted, fmt.Sprintf("issuer %s is not a trust anchor", id))
		return
	}
	var key *Key
	for i := range anchor.Keys {
		if anchor.Keys[i].Kid == kid {
			key = &anchor.Keys[i]
			break
		}
	}
	if key == nil {
		v.Untrusted = append(v.Untrusted, fmt.Sprintf("issuer %s has no key %s", id, kid))
		return
	}
	if key.Alg != alg {
		v.errf("proof.alg does not match the issuer key")
		return
	}
	if alg == "bip340" {
		v.Untrusted = append(v.Untrusted, "the issuer key uses bip340, which this verifier does not implement")
		return
	}
	pub, err := hex.DecodeString(key.PublicKey)
	hash, _ := str(doc, "hash")
	format, _ := str(doc, "format")
	sigBytes, _ := hex.DecodeString(sig)
	if err != nil || len(pub) != ed25519.PublicKeySize ||
		!ed25519.Verify(ed25519.PublicKey(pub), []byte(format+"\nissue\n"+hash), sigBytes) {
		v.errf("issuer signature does not verify")
		return
	}
	if key.Compromised {
		v.Untrusted = append(v.Untrusted, fmt.Sprintf("issuer key %s is marked compromised", kid))
		return
	}
	if timeRe.MatchString(signedAt) {
		if timeRe.MatchString(key.NotBefore) && signedAt < key.NotBefore {
			v.Untrusted = append(v.Untrusted, fmt.Sprintf("signed before issuer key %s was valid", kid))
		} else if timeRe.MatchString(key.NotAfter) && signedAt >= key.NotAfter {
			v.Untrusted = append(v.Untrusted, fmt.Sprintf("signed after issuer key %s expired", kid))
		} else if timeRe.MatchString(key.RevokedAt) && signedAt >= key.RevokedAt {
			v.Untrusted = append(v.Untrusted, fmt.Sprintf("signed after issuer key %s was revoked", kid))
		}
	}
}

// ── wire form ────────────────────────────────────────────────────────────────

// ParseWire splits a scanned URL into its origin and the signed document.
func ParseWire(text string) (origin string, doc map[string]any, err error) {
	m := wireRe.FindStringSubmatch(text)
	if m == nil || len(m[2]) > 4096 { // RE2 caps a repeat at 1000, so the 4096 limit is checked here
		return "", nil, errors.New("not a helix-qr URL: expected https://<resolver>/q/<payload>")
	}
	raw, derr := base64.RawURLEncoding.DecodeString(m[2])
	if derr != nil {
		return "", nil, errors.New("the payload is not base64url JSON")
	}
	v, jerr := DecodeJSON(raw)
	if jerr != nil {
		return "", nil, errors.New("the payload is not base64url JSON")
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return "", nil, errors.New("the payload is not a JSON object")
	}
	return m[1], obj, nil
}

// ── verifying a reference ────────────────────────────────────────────────────

// VerifyReference verifies a scanned URL (subject) against the trust anchors.
// now is RFC 3339 UTC, or "" for no clock. The Reference is non-nil whenever
// the payload parsed, even if it did not verify.
func VerifyReference(subject string, trust *Trust, now string) (*Reference, *Verdict) {
	v := &Verdict{}
	origin, doc, err := ParseWire(subject)
	if err != nil {
		v.errf("%s", err.Error())
		return nil, v.finish()
	}
	ref := &Reference{Doc: doc}
	if unknown := unknownKeys(doc, refKeys); len(unknown) > 0 {
		v.errf("unknown field(s): %s", strings.Join(unknown, ", "))
	}
	if f, _ := str(doc, "format"); f != Format {
		v.errf("format must be %s", Format)
	}
	if k, _ := doc["kind"].(string); !kinds[k] {
		v.errf("kind must be agent or business")
	}
	sid, _ := str(doc, "sid")
	if !sidRe.MatchString(sid) {
		v.errf("sid must be a sid_<slug> identifier")
	}
	card, hasCard := doc["card"]
	if hasCard && card != nil {
		c, isObj := card.(map[string]any)
		id, _ := str(c, "id")
		h, _ := str(c, "hash")
		if !(isObj && len(c) == 2 && slugRe.MatchString(id) && hex64.MatchString(h)) {
			v.errf("card must be {id, hash}")
		}
	}
	if k, _ := doc["kind"].(string); k == "business" && (!hasCard || card == nil) {
		v.errf("a business reference must carry a card")
	}
	if p := OriginProblem(doc["resolver"]); p != "" {
		v.errf("%s", p)
	}
	if d, has := doc["domain"]; has {
		if s, ok := d.(string); !ok || !PublicHost(s) {
			v.errf("domain must be a public DNS name")
		}
	}
	issued, ok1 := timeOK(doc["issued_at"])
	expires, ok2 := timeOK(doc["expires_at"])
	switch {
	case !ok1 || !ok2:
		v.errf("issued_at and expires_at must be RFC 3339 UTC")
	case !expires.After(issued):
		v.errf("expires_at must be after issued_at")
	case expires.Sub(issued) > maxLifetime:
		v.errf("a reference may not be valid for more than 400 days")
	}
	if n, _ := str(doc, "nonce"); !nonceRe.MatchString(n) {
		v.errf("nonce must be 16 random bytes, base64url")
	}
	if secrets := findSecrets(doc, ""); len(secrets) > 0 {
		v.errf("secret material must not be present: %s", strings.Join(secrets, ", "))
	}
	if len(v.Errors) > 0 {
		return ref, v.finish()
	}

	h, herr := docHash(doc)
	if given, _ := str(doc, "hash"); herr != nil || given != h {
		v.errf("hash does not match the document")
		return ref, v.finish()
	}
	ref.Hash, ref.Resolver, ref.SID = h, doc["resolver"].(string), sid
	issuedAt, _ := str(doc, "issued_at")
	issuerCheck(doc, trust, issuedAt, v)

	if origin != ref.Resolver {
		v.errf("the URL's origin (%s) does not match the signed resolver (%s)", origin, ref.Resolver)
	}
	if now == "" {
		v.Untrusted = append(v.Untrusted, "expiry not checked (no clock)")
	} else if t, ok := timeOK(now); !ok {
		v.errf("now must be RFC 3339 UTC")
	} else if !t.Before(expires) {
		v.Untrusted = append(v.Untrusted, "the reference has expired")
	} else if t.Add(skew).Before(issued) {
		v.Untrusted = append(v.Untrusted, "the reference is not valid yet")
	}
	return ref, v.finish()
}

// ── resolution envelope ──────────────────────────────────────────────────────

// CheckEnvelope checks everything about a resolution that needs no knowledge of
// sid certificates. fetchedFrom is the origin it was fetched from ("" if unknown).
func CheckEnvelope(res map[string]any, ref *Reference, trust *Trust, now, fetchedFrom string) *Verdict {
	v := &Verdict{}
	if unknown := unknownKeys(res, resKeys); len(unknown) > 0 {
		v.errf("unknown field(s): %s", strings.Join(unknown, ", "))
	}
	if f, _ := str(res, "format"); f != ResolutionFormat {
		v.errf("format must be %s", ResolutionFormat)
	}
	status, _ := str(res, "status")
	if !statuses[status] {
		v.errf("status must be active, suspended, revoked or superseded")
	}
	if rh, _ := str(res, "reference_hash"); !hex64.MatchString(rh) {
		v.errf("reference_hash must be 64 hex characters")
	}
	if sb, has := res["superseded_by"]; has {
		if s, ok := sb.(string); !ok || !hex64.MatchString(s) {
			v.errf("superseded_by must be 64 hex characters")
		}
	}
	issued, ok1 := timeOK(res["issued_at"])
	fresh, ok2 := timeOK(res["fresh_until"])
	switch {
	case !ok1 || !ok2:
		v.errf("issued_at and fresh_until must be RFC 3339 UTC")
	case !fresh.After(issued):
		v.errf("fresh_until must be after issued_at")
	case fresh.Sub(issued) > maxFresh:
		v.errf("a resolution may not be fresh for more than 24 hours")
	}
	if p := OriginProblem(res["resolver"]); p != "" {
		v.errf("%s", p)
	}
	rest := map[string]any{}
	for k, val := range res {
		if k != "certificate" && k != "runtime" {
			rest[k] = val
		}
	}
	if secrets := findSecrets(rest, ""); len(secrets) > 0 {
		v.errf("secret material must not be present: %s", strings.Join(secrets, ", "))
	}
	if len(v.Errors) > 0 {
		return v.finish()
	}

	h, herr := docHash(res)
	if given, _ := str(res, "hash"); herr != nil || given != h {
		v.errf("hash does not match the document")
		return v.finish()
	}
	issuedAt, _ := str(res, "issued_at")
	issuerCheck(res, trust, issuedAt, v)
	resIssuer, _ := res["issuer"].(map[string]any)
	refIssuer, _ := ref.Doc["issuer"].(map[string]any)
	if a, _ := str(resIssuer, "id"); a != func() string { s, _ := str(refIssuer, "id"); return s }() {
		v.errf("the resolution must be signed by the reference's issuer")
	}
	if rh, _ := str(res, "reference_hash"); rh != ref.Hash {
		v.errf("this resolution answers a different reference")
	}
	if r, _ := str(res, "resolver"); r != ref.Resolver {
		v.errf("the resolution's resolver differs from the reference's")
	}
	if fetchedFrom == "" {
		v.Untrusted = append(v.Untrusted, "where the resolution was fetched from was not checked")
	} else if fetchedFrom != ref.Resolver {
		v.errf("fetched from %s, but the reference names %s", fetchedFrom, ref.Resolver)
	}
	if now == "" {
		v.Untrusted = append(v.Untrusted, "freshness not checked (no clock)")
	} else if t, ok := timeOK(now); !ok {
		v.errf("now must be RFC 3339 UTC")
	} else if !t.Before(fresh) {
		v.Untrusted = append(v.Untrusted, "the resolution is stale")
	} else if t.Add(skew).Before(issued) {
		v.Untrusted = append(v.Untrusted, "the resolution is not valid yet")
	}
	if status != "active" {
		v.Untrusted = append(v.Untrusted, "the contact is "+status)
	}
	return v.finish()
}
