package resolver

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/qr"
)

type vec struct {
	Name    string          `json:"name"`
	Kind    string          `json:"kind"`
	Subject json.RawMessage `json:"subject"`
	Ref     json.RawMessage `json:"ref"`
	Res     json.RawMessage `json:"res"`
	Trust   json.RawMessage `json:"trust"`
}

var vectors map[string]vec

func init() {
	raw, err := os.ReadFile("../qr/testdata/vectors.json")
	if err != nil {
		panic(err)
	}
	var doc struct {
		Vectors []vec `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(err)
	}
	vectors = map[string]vec{}
	for _, v := range doc.Vectors {
		vectors[v.Name] = v
	}
}

const origin = "https://contact.example"
const fixedNow = "2026-11-20T12:00:00Z"

func subject(name string) string {
	var s string
	if err := json.Unmarshal(vectors[name].Subject, &s); err != nil {
		panic(name)
	}
	return s
}

func res(name string) []byte { return []byte(vectors[name].Res) }

type env struct {
	t     *testing.T
	s     *Server
	store FileStore
	now   time.Time
	token string
	h     http.Handler
}

func newEnv(t *testing.T) *env {
	t.Helper()
	trust, err := qr.ParseTrust(vectors["reference-valid-agent"].Trust)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, store: FileStore{Dir: t.TempDir()}, token: "publish-secret-token"}
	e.now, _ = time.Parse("2006-01-02T15:04:05Z", fixedNow)
	sum := sha256.Sum256([]byte(e.token))
	e.s, err = New(Config{Origin: origin, Trust: trust, Store: e.store, PublishTokenSHA256: hex.EncodeToString(sum[:]), Now: func() time.Time { return e.now }, RatePerSec: 1000, Burst: 1000})
	if err != nil {
		t.Fatal(err)
	}
	e.h = e.s.Handler()
	return e
}

func refHash(t *testing.T, wire string) string {
	t.Helper()
	_, doc, err := qr.ParseWire(wire)
	if err != nil {
		t.Fatal(err)
	}
	return doc["hash"].(string)
}

func (e *env) seed(wire string, raw []byte) {
	e.t.Helper()
	if err := e.store.Put(refHash(e.t, wire), raw); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) get(wire string, host string) *httptest.ResponseRecorder {
	e.t.Helper()
	path := wire[strings.Index(wire, "/q/"):]
	req := httptest.NewRequest("GET", path, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e *env) publish(token, reference string, resolution []byte) *httptest.ResponseRecorder {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{"reference": reference, "resolution": json.RawMessage(resolution)})
	req := httptest.NewRequest("PUT", "/v1/publish", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func code(rec *httptest.ResponseRecorder) string {
	var b struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &b)
	return b.Error.Code
}

// ── serving ──────────────────────────────────────────────────────────────────

func TestAVerifiedCurrentResolutionIsServedExactlyAsSigned(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	e.seed(wire, res("envelope-valid"))
	rec := e.get(wire, "contact.example")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec.Body.String() != string(res("envelope-valid")) {
		t.Fatal("the resolver must not rewrite what the issuer signed")
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.HasPrefix(cc, "public, max-age=") {
		t.Fatalf("Cache-Control %q", cc)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("headers")
	}
}

func TestNothingIsServedForAReferenceThatDoesNotVerify(t *testing.T) {
	for name, want := range map[string]struct {
		status int
		code   string
	}{
		"reference-tampered-sid":                     {400, "invalid_reference"},
		"reference-tampered-and-rehashed":            {400, "invalid_reference"},
		"reference-signed-by-attacker-claiming-root": {400, "invalid_reference"},
		"reference-unknown-field":                    {400, "invalid_reference"},
		"reference-resolver-ip-address":              {400, "invalid_reference"},
		"reference-expired":                          {200, ""}, // judged against the clock below
		"reference-unknown-issuer":                   {404, "not_found"},
		"reference-issuer-key-compromised":           {404, "not_found"},
		"reference-signed-after-key-revoked":         {404, "not_found"},
	} {
		e := newEnv(t)
		wire := subject(name)
		// even with a perfectly good resolution sitting in the store for the honest reference
		e.seed(subject("reference-valid-agent"), res("envelope-valid"))
		rec := e.get(wire, "contact.example")
		if rec.Code != want.status || code(rec) != want.code {
			t.Errorf("%s: %d %s, want %d %s (%s)", name, rec.Code, code(rec), want.status, want.code, rec.Body)
		}
	}
}

func TestAnExpiredReferenceIsGone(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	e.seed(wire, res("envelope-valid"))
	e.now = e.now.AddDate(1, 1, 0)
	if rec := e.get(wire, "contact.example"); rec.Code != 410 || code(rec) != "expired" {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestTheRequestMustBeAddressedToThisResolver(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	e.seed(wire, res("envelope-valid"))
	for _, host := range []string{"evil.example", "contact.example.evil.example", "localhost", "127.0.0.1", "contact.example:8443", ""} {
		if rec := e.get(wire, host); rec.Code != 421 {
			t.Errorf("Host %q: %d", host, rec.Code)
		}
	}
	if rec := e.get(wire, "CONTACT.EXAMPLE"); rec.Code != 200 {
		t.Errorf("host names are case-insensitive: %d", rec.Code)
	}
}

func TestAResolverForAnotherDomainDoesNotServeThisReference(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	trust, _ := qr.ParseTrust(vectors["reference-valid-agent"].Trust)
	other, err := New(Config{Origin: "https://elsewhere.example", Trust: trust, Store: e.store, Now: e.s.now})
	if err != nil {
		t.Fatal(err)
	}
	e.seed(wire, res("envelope-valid"))
	req := httptest.NewRequest("GET", wire[strings.Index(wire, "/q/"):], nil)
	req.Host = "elsewhere.example"
	rec := httptest.NewRecorder()
	other.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "does not match the signed resolver") {
		t.Fatalf("a reference signed for contact.example must not be served from elsewhere.example: %d %s", rec.Code, rec.Body)
	}
}

func TestUnknownContactsAndQueryStrings(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	if rec := e.get(wire, "contact.example"); rec.Code != 404 {
		t.Errorf("nothing stored: %d", rec.Code)
	}
	req := httptest.NewRequest("GET", wire[strings.Index(wire, "/q/"):]+"?redirect=https://evil.example", nil)
	req.Host = "contact.example"
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Errorf("a query string: %d", rec.Code)
	}
}

func TestAStoredResolutionThatDoesNotVerifyIsNeverServed(t *testing.T) {
	wire := subject("reference-valid-agent")
	for name, stored := range map[string][]byte{
		"a resolution for another reference": res("envelope-for-another-reference"),
		"tampered and rehashed":              res("envelope-tampered-and-rehashed"),
		"signed by another issuer":           res("envelope-issuer-is-not-the-references"),
		"a different resolver field":         res("envelope-resolver-field-differs"),
		"garbage":                            []byte("not json"),
		"an array":                           []byte("[]"),
		"unknown fields":                     res("envelope-unknown-field"),
	} {
		e := newEnv(t)
		e.seed(wire, stored)
		rec := e.get(wire, "contact.example")
		if rec.Code != 503 || code(rec) != "resolution_unavailable" || rec.Header().Get("Retry-After") == "" {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body)
		}
		if strings.Contains(rec.Body.String(), `"hash"`) {
			t.Errorf("%s: leaked the bad document", name)
		}
	}
}

func TestAStaleResolutionIsNotServed(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	e.seed(wire, res("envelope-valid"))
	e.now = e.now.Add(24 * time.Hour) // past fresh_until: this is exactly what a replayed old response looks like
	if rec := e.get(wire, "contact.example"); rec.Code != 503 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestARevokedContactIsGoneAndNotCached(t *testing.T) {
	for _, name := range []string{"envelope-revoked", "envelope-suspended", "envelope-superseded"} {
		e := newEnv(t)
		wire := subject("reference-valid-agent")
		e.seed(wire, res(name))
		rec := e.get(wire, "contact.example")
		if rec.Code != 410 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: %d %q", name, rec.Code, rec.Header().Get("Cache-Control"))
		}
		var doc map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &doc)
		if doc["status"] == "active" || doc["format"] != "helix-qr-resolution/1" {
			t.Errorf("%s: the signed document must be served so the client can show why: %s", name, rec.Body)
		}
	}
}

// ── publishing ───────────────────────────────────────────────────────────────

func TestPublishingNeedsTheToken(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	for _, tok := range []string{"", "wrong", e.token + "x", strings.ToUpper(e.token)} {
		if rec := e.publish(tok, wire, res("envelope-valid")); rec.Code != 401 {
			t.Errorf("%q: %d", tok, rec.Code)
		}
	}
	if _, err := e.store.Get(refHash(t, wire)); err == nil {
		t.Fatal("nothing may be stored by an unauthenticated caller")
	}
	if rec := e.publish(e.token, wire, res("envelope-valid")); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := e.get(wire, "contact.example"); rec.Code != 200 {
		t.Fatalf("published, then served: %d", rec.Code)
	}
}

func TestPublishingIsDisabledWithoutAConfiguredToken(t *testing.T) {
	e := newEnv(t)
	trust, _ := qr.ParseTrust(vectors["reference-valid-agent"].Trust)
	s, _ := New(Config{Origin: origin, Trust: trust, Store: e.store, Now: e.s.now})
	req := httptest.NewRequest("PUT", "/v1/publish", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 503 {
		t.Fatalf("%d", rec.Code)
	}
}

func TestOnlyVerifiedResolutionsCanBePublished(t *testing.T) {
	wire := subject("reference-valid-agent")
	for name, tc := range map[string]struct {
		reference  string
		resolution []byte
	}{
		"for another reference":                {wire, res("envelope-for-another-reference")},
		"tampered and rehashed":                {wire, res("envelope-tampered-and-rehashed")},
		"signed by the wrong issuer":           {wire, res("envelope-issuer-is-not-the-references")},
		"signed by an unrelated key":           {wire, res("envelope-signed-by-another-issuer")},
		"a window longer than a day":           {wire, res("envelope-window-too-long")},
		"unknown fields":                       {wire, res("envelope-unknown-field")},
		"names another resolver":               {wire, res("envelope-resolver-field-differs")},
		"for a reference that does not verify": {subject("reference-tampered-and-rehashed"), res("envelope-valid")},
		"for an untrusted reference":           {subject("reference-unknown-issuer"), res("envelope-valid")},
		"for a reference hosted elsewhere":     {subject("reference-copied-to-another-domain"), res("envelope-valid")},
	} {
		e := newEnv(t)
		rec := e.publish(e.token, tc.reference, tc.resolution)
		if rec.Code != 422 && rec.Code != 400 {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body)
		}
		if _, err := e.store.Get(refHash(t, wire)); err == nil {
			t.Errorf("%s: it was stored anyway", name)
		}
	}
	// stale
	e := newEnv(t)
	e.now = e.now.Add(48 * time.Hour)
	if rec := e.publish(e.token, subject("reference-valid-agent"), res("envelope-valid")); rec.Code != 422 {
		t.Errorf("a stale resolution: %d", rec.Code)
	}
}

func TestPublishBodyHygiene(t *testing.T) {
	e := newEnv(t)
	for name, body := range map[string]string{
		"empty": "", "not json": "{", "no resolution": `{"reference":"x"}`, "unknown field": `{"reference":"x","resolution":{},"extra":1}`,
		"two documents": `{"reference":"x","resolution":{}}{}`,
	} {
		req := httptest.NewRequest("PUT", "/v1/publish", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+e.token)
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	big := httptest.NewRequest("PUT", "/v1/publish", strings.NewReader(`{"reference":"`+strings.Repeat("a", 300<<10)+`"}`))
	big.Header.Set("Content-Type", "application/json")
	big.Header.Set("Authorization", "Bearer "+e.token)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, big)
	if rec.Code != 413 {
		t.Errorf("oversized: %d", rec.Code)
	}
	wrongType := httptest.NewRequest("PUT", "/v1/publish", strings.NewReader("{}"))
	wrongType.Header.Set("Authorization", "Bearer "+e.token)
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, wrongType)
	if rec.Code != 415 {
		t.Errorf("content type: %d", rec.Code)
	}
}

func TestRevocationAlwaysWinsAndIsPermanent(t *testing.T) {
	e := newEnv(t)
	wire := subject("reference-valid-agent")
	if rec := e.publish(e.token, wire, res("envelope-valid")); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	// revoked at the very same second as the active one: the revocation wins
	if rec := e.publish(e.token, wire, res("envelope-revoked")); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := e.get(wire, "contact.example"); rec.Code != 410 {
		t.Fatalf("revoked, so gone: %d", rec.Code)
	}
	// and an old, still-valid, perfectly signed ACTIVE resolution cannot be replayed over it
	if rec := e.publish(e.token, wire, res("envelope-valid")); rec.Code != 409 {
		t.Fatalf("replaying the old active resolution over a revocation must fail: %d %s", rec.Code, rec.Body)
	}
	if rec := e.get(wire, "contact.example"); rec.Code != 410 {
		t.Fatalf("still revoked: %d", rec.Code)
	}
	// re-publishing the revocation itself is harmless
	if rec := e.publish(e.token, wire, res("envelope-revoked")); rec.Code != 200 {
		t.Fatalf("%d", rec.Code)
	}
}

func TestAcceptOrdersResolutionsForward(t *testing.T) {
	mk := func(status, at, hash string) map[string]any {
		return map[string]any{"status": status, "issued_at": at, "hash": hash}
	}
	for name, tc := range map[string]struct {
		stored, next map[string]any
		ok           bool
	}{
		"first":                           {nil, mk("active", "2026-11-20T11:00:00Z", "a"), true},
		"newer replaces older":            {mk("active", "2026-11-20T11:00:00Z", "a"), mk("active", "2026-11-20T12:00:00Z", "b"), true},
		"older never replaces newer":      {mk("active", "2026-11-20T12:00:00Z", "b"), mk("active", "2026-11-20T11:00:00Z", "a"), false},
		"same instant, different content": {mk("active", "2026-11-20T11:00:00Z", "a"), mk("active", "2026-11-20T11:00:00Z", "b"), false},
		"same document again":             {mk("active", "2026-11-20T11:00:00Z", "a"), mk("active", "2026-11-20T11:00:00Z", "a"), true},
		"revocation wins a tie":           {mk("active", "2026-11-20T11:00:00Z", "a"), mk("revoked", "2026-11-20T11:00:00Z", "r"), true},
		"suspension does not win a tie":   {mk("active", "2026-11-20T11:00:00Z", "a"), mk("suspended", "2026-11-20T11:00:00Z", "s"), false},
		"suspension can be lifted later":  {mk("suspended", "2026-11-20T11:00:00Z", "s"), mk("active", "2026-11-20T12:00:00Z", "b"), true},
		"revoked is permanent":            {mk("revoked", "2026-11-20T11:00:00Z", "r"), mk("active", "2026-11-21T11:00:00Z", "z"), false},
		"superseded is permanent":         {mk("superseded", "2026-11-20T11:00:00Z", "r"), mk("active", "2026-11-21T11:00:00Z", "z"), false},
		"revoked stays revoked, newer":    {mk("revoked", "2026-11-20T11:00:00Z", "r"), mk("revoked", "2026-11-21T11:00:00Z", "r2"), true},
	} {
		if err := Accept(tc.stored, tc.next); (err == nil) != tc.ok {
			t.Errorf("%s: err=%v, want ok=%v", name, err, tc.ok)
		}
	}
}

func TestTheStoreNeverBuildsAPathFromInput(t *testing.T) {
	s := FileStore{Dir: t.TempDir()}
	for _, bad := range []string{"../x", "..", "a/b", "", strings.Repeat("g", 64), strings.Repeat("A", 64), strings.Repeat("a", 63)} {
		if _, err := s.Get(bad); err != ErrNotFound {
			t.Errorf("Get(%q): %v", bad, err)
		}
		if err := s.Put(bad, []byte("x")); err == nil {
			t.Errorf("Put(%q) must refuse", bad)
		}
	}
	h := strings.Repeat("a", 64)
	if err := s.Put(h, []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(s.Dir + "/" + h + ".json"); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", st, err)
	}
}

func TestOneAddressCannotHammerTheResolver(t *testing.T) {
	e := newEnv(t)
	e.s.limiter = nil
	trust, _ := qr.ParseTrust(vectors["reference-valid-agent"].Trust)
	s, _ := New(Config{Origin: origin, Trust: trust, Store: e.store, Now: e.s.now, RatePerSec: 1, Burst: 3})
	wire := subject("reference-valid-agent")
	codes := []int{}
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest("GET", wire[strings.Index(wire, "/q/"):], nil)
		req.Host = "contact.example"
		req.RemoteAddr = "203.0.113.9:5555"
		req.Header.Set("X-Forwarded-For", "198.51.100."+string(rune('1'+i))) // a claim, not a fact
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		codes = append(codes, rec.Code)
	}
	if codes[3] != 429 || codes[4] != 429 {
		t.Fatalf("%v", codes)
	}
}

func TestConfigurationIsValidated(t *testing.T) {
	trust, _ := qr.ParseTrust(vectors["reference-valid-agent"].Trust)
	st := FileStore{Dir: t.TempDir()}
	for name, c := range map[string]Config{
		"http origin":       {Origin: "http://contact.example", Trust: trust, Store: st},
		"ip origin":         {Origin: "https://203.0.113.7", Trust: trust, Store: st},
		"no trust":          {Origin: origin, Store: st},
		"empty trust":       {Origin: origin, Trust: &qr.Trust{}, Store: st},
		"no store":          {Origin: origin, Trust: trust},
		"bad publish token": {Origin: origin, Trust: trust, Store: st, PublishTokenSHA256: "nothex"},
	} {
		if _, err := New(c); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
}
