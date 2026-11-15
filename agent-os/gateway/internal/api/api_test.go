package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/auth"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/ratelimit"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ── a kernel that records what it is asked and answers from a script ─────────

type fakeKernel struct {
	mu       sync.Mutex
	contexts []*kernelv1.RequestContext // every RequestContext received, in order
	calls    []string

	authorize     func(*kernelv1.AuthorizeActionRequest) (*kernelv1.AuthorizeActionResponse, error)
	pending       *kernelv1.GetPendingResponse
	confirm       func(*kernelv1.ConfirmActionRequest) (*kernelv1.AuthorizeActionResponse, error)
	begin         func(*kernelv1.BeginExecutionRequest) (*kernelv1.BeginExecutionResponse, error)
	invoke        func(*kernelv1.InvokePluginRequest) (*kernelv1.InvokePluginResponse, error)
	lastInvoke    *kernelv1.InvokePluginRequest
	lastComponent []byte
	lastManifest  string
	err           error // returned by every call when set
	delay         time.Duration
}

func (f *fakeKernel) note(name string, ctx *kernelv1.RequestContext) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.contexts = append(f.contexts, ctx)
}

func (f *fakeKernel) called(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == name {
			n++
		}
	}
	return n
}

func (f *fakeKernel) last() *kernelv1.RequestContext {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.contexts[len(f.contexts)-1]
}

func (f *fakeKernel) AuthorizeAction(_ context.Context, in *kernelv1.AuthorizeActionRequest, _ ...grpc.CallOption) (*kernelv1.AuthorizeActionResponse, error) {
	f.note("authorize", in.Context)
	time.Sleep(f.delay)
	if f.err != nil {
		return nil, f.err
	}
	if f.authorize != nil {
		return f.authorize(in)
	}
	return &kernelv1.AuthorizeActionResponse{Decision: kernelv1.Decision_DECISION_ALLOW, Grant: &kernelv1.Grant{Id: "grant_1", Format: "helix-grant/1", MaxAmountMinor: 1200, SingleUse: true, Signature: "sig"}}, nil
}

func (f *fakeKernel) ConfirmAction(_ context.Context, in *kernelv1.ConfirmActionRequest, _ ...grpc.CallOption) (*kernelv1.AuthorizeActionResponse, error) {
	f.note("confirm", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	if f.confirm != nil {
		return f.confirm(in)
	}
	return &kernelv1.AuthorizeActionResponse{Decision: kernelv1.Decision_DECISION_ALLOW, Grant: &kernelv1.Grant{Id: "grant_2"}}, nil
}

func (f *fakeKernel) BeginExecution(_ context.Context, in *kernelv1.BeginExecutionRequest, _ ...grpc.CallOption) (*kernelv1.BeginExecutionResponse, error) {
	f.note("begin", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	if f.begin != nil {
		return f.begin(in)
	}
	return &kernelv1.BeginExecutionResponse{State: kernelv1.ExecutionState_EXECUTION_STATE_PERMITTED, ExecutionId: "exec_1"}, nil
}

func (f *fakeKernel) RecordResult(_ context.Context, in *kernelv1.RecordResultRequest, _ ...grpc.CallOption) (*kernelv1.RecordResultResponse, error) {
	f.note("record", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.RecordResultResponse{State: in.State, ReceiptHash: "abc"}, nil
}

func (f *fakeKernel) RevokeGrant(_ context.Context, in *kernelv1.RevokeGrantRequest, _ ...grpc.CallOption) (*kernelv1.RevokeGrantResponse, error) {
	f.note("revoke", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.RevokeGrantResponse{Revoked: true}, nil
}

func (f *fakeKernel) VerifyIdentity(_ context.Context, in *kernelv1.VerifyIdentityRequest, _ ...grpc.CallOption) (*kernelv1.VerifyIdentityResponse, error) {
	f.note("verify", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.VerifyIdentityResponse{Ok: true, Trusted: true, Sid: "sid_front-desk", Registered: in.Register}, nil
}

func (f *fakeKernel) GetPending(_ context.Context, in *kernelv1.GetPendingRequest, _ ...grpc.CallOption) (*kernelv1.GetPendingResponse, error) {
	f.note("get_pending", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	if f.pending == nil {
		return nil, status.Error(codes.NotFound, "not found")
	}
	return f.pending, nil
}

func (f *fakeKernel) InstallPlugin(_ context.Context, in *kernelv1.InstallPluginRequest, _ ...grpc.CallOption) (*kernelv1.InstallPluginResponse, error) {
	f.note("install_plugin", in.Context)
	f.lastComponent = in.Component
	f.lastManifest = in.ManifestJson
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.InstallPluginResponse{Installed: true, Plugin: &kernelv1.PluginInfo{Id: "acme.pricing", Version: "1.0.0", Tools: []*kernelv1.PluginTool{{Name: "quote"}}}}, nil
}

func (f *fakeKernel) RemovePlugin(_ context.Context, in *kernelv1.RemovePluginRequest, _ ...grpc.CallOption) (*kernelv1.RemovePluginResponse, error) {
	f.note("remove_plugin", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.RemovePluginResponse{Removed: true}, nil
}

func (f *fakeKernel) ListPlugins(_ context.Context, in *kernelv1.ListPluginsRequest, _ ...grpc.CallOption) (*kernelv1.ListPluginsResponse, error) {
	f.note("list_plugins", in.Context)
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.ListPluginsResponse{Plugins: []*kernelv1.PluginInfo{{Id: "acme.pricing", Version: "1.0.0"}}}, nil
}

func (f *fakeKernel) InvokePlugin(_ context.Context, in *kernelv1.InvokePluginRequest, _ ...grpc.CallOption) (*kernelv1.InvokePluginResponse, error) {
	f.note("invoke_plugin", in.Context)
	f.lastInvoke = in
	if f.err != nil {
		return nil, f.err
	}
	if f.invoke != nil {
		return f.invoke(in)
	}
	return &kernelv1.InvokePluginResponse{Status: "ok", ResultJson: `{"total_minor":1350}`, ProposedIntentsJson: []string{`{"capability":"merchant.order","organization_id":"org_a"}`}}, nil
}

func (f *fakeKernel) Health(_ context.Context, _ *kernelv1.HealthRequest, _ ...grpc.CallOption) (*kernelv1.HealthResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &kernelv1.HealthResponse{Status: "ok", Version: "test", PolicyAvailable: true, AuditEntries: 3, AuditHead: "h"}, nil
}

// ── the world: tokens, owners, a server ──────────────────────────────────────

type world struct {
	t      *testing.T
	k      *fakeKernel
	srv    *Server
	h      http.Handler
	tokens map[string]string // name -> bearer token
	file   string
	now    time.Time
}

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, k: &fakeKernel{}, tokens: map[string]string{}, now: time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)}
	type tok struct{ name, org, principal, kind, roles string }
	var entries []string
	for _, c := range []tok{
		{"agent", "org_a", "sid_front-desk", "agent", ""},
		{"rival", "org_a", "sid_rival", "agent", ""},
		{"alice", "org_a", "user:alice", "user", ""},                   // owns sid_front-desk
		{"bob", "org_a", "user:bob", "user", ""},                       // a user, but not its owner
		{"rita", "org_a", "user:rita", "user", `"reviewer"`},           // reviewer
		{"admin", "org_a", "user:admin", "user", `"grant_admin"`},      // may revoke grants
		{"orch", "org_a", "svc:orchestrator", "service", `"proposer"`}, // proposes for agents
		{"exec", "org_a", "svc:merchant-adapter", "service", `"executor"`},
		{"reg", "org_a", "svc:registry", "service", `"registrar"`},
		{"plain", "org_a", "svc:plain", "service", ``},
		{"deploy", "org_a", "svc:deploy", "service", `"plugin_admin"`},
		{"zed", "org_b", "user:zed", "user", `"reviewer"`},
	} {
		token, sha, err := auth.NewToken()
		if err != nil {
			t.Fatal(err)
		}
		w.tokens[c.name] = token
		entries = append(entries, `{"id":"`+c.name+`","sha256":"`+sha+`","organization_id":"`+c.org+`","principal":"`+c.principal+`","kind":"`+c.kind+`","roles":[`+c.roles+`]}`)
	}
	w.file = filepath.Join(t.TempDir(), "principals.json")
	doc := `{"tokens":[` + strings.Join(entries, ",") + `],"agents":[{"organization_id":"org_a","sid":"sid_front-desk","owners":["user:alice"]}]}`
	if err := os.WriteFile(w.file, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	w.srv = New(Config{Kernel: w.k, Auth: auth.Open(w.file, 0), Now: func() time.Time { return w.now }, RatePerSec: 1000, Burst: 1000})
	w.h = w.srv.Handler()
	return w
}

type resp struct {
	Code   int
	Header http.Header
	Body   map[string]any
	Raw    string
}

func (w *world) do(as, method, path, body string, hdr ...string) resp {
	w.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if as != "" {
		req.Header.Set("Authorization", "Bearer "+w.tokens[as])
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	w.h.ServeHTTP(rec, req)
	out := resp{Code: rec.Code, Header: rec.Header(), Raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
	return out
}

func intentBody(agent string, extra string) string {
	return `{"intent":{"id":"i1","agent_id":"` + agent + `","capability":"merchant.order","tool":"merchant.checkout","target":"merchant:m_1","operation":"order.create","risk":"medium","arguments":{"sku":"latte"},"amount_minor":1200,"currency":"USD","idempotency_key":"k1","audience":"svc:merchant-adapter"` + extra + `}}`
}

// intentObj is the intent object alone, for bodies that nest it.
func intentObj(agent string) string {
	b := intentBody(agent, "")
	return b[len(`{"intent":`) : len(b)-1]
}

func heldPending(kind string) *kernelv1.GetPendingResponse {
	return &kernelv1.GetPendingResponse{
		PendingId: "pending-1", Kind: kind, State: "pending", CreatedAt: "2026-11-20T12:00:00Z", ExpiresAt: "2026-11-20T13:00:00Z",
		Intent: &kernelv1.ActionIntent{Id: "i1", AgentId: "sid_front-desk", Capability: "merchant.order", Risk: kernelv1.Risk_RISK_MEDIUM, AmountMinor: 1200, Currency: "USD"},
	}
}

// ── identity comes from the token and from nothing else ──────────────────────

func TestTheKernelSeesTheAuthenticatedCallerNotWhatTheClientClaims(t *testing.T) {
	w := newWorld(t)
	r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", ""),
		"X-Helix-Principal", "user:root", "X-Helix-Org", "org_b", "X-Org-Id", "org_b", "X-Principal", "svc:admin",
		"X-Forwarded-User", "root", "X-Roles", "reviewer", "X-Correlation-Id", "forged", "X-Request-Id", "forged")
	if r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
	ctx := w.k.last()
	if ctx.OrganizationId != "org_a" || ctx.Principal != "sid_front-desk" || ctx.PrincipalKind != kernelv1.PrincipalKind_PRINCIPAL_KIND_AGENT {
		t.Fatalf("the kernel was told %+v", ctx)
	}
	if !strings.HasPrefix(ctx.CorrelationId, "req_") || ctx.CorrelationId == "forged" {
		t.Fatalf("correlation id must be the gateway's own: %q", ctx.CorrelationId)
	}
	if r.Header.Get("X-Request-Id") != ctx.CorrelationId {
		t.Fatal("the response carries the correlation id the kernel saw")
	}
}

func TestPrivilegedHeadersAreStrippedBeforeAnyHandlerRuns(t *testing.T) {
	var seen http.Header
	probe := http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { seen = r.Header.Clone() })
	s := New(Config{Kernel: &fakeKernel{}, Auth: auth.Open(filepath.Join(t.TempDir(), "none.json"), 0)})
	h := s.stripPrivileged(probe)
	req := httptest.NewRequest("GET", "/", nil)
	for _, k := range []string{"X-Helix-Principal", "x-helix-anything", "X-Org-Id", "X-User", "X-Forwarded-User", "X-Auth-Request-Email", "X-Roles", "X-Tenant-Id"} {
		req.Header.Set(k, "evil")
	}
	req.Header.Set("Authorization", "Bearer keep")
	req.Header.Set("Accept", "application/json")
	h.ServeHTTP(httptest.NewRecorder(), req)
	for k := range seen {
		if strings.HasPrefix(strings.ToLower(k), "x-") {
			t.Errorf("%s survived", k)
		}
	}
	if seen.Get("Authorization") == "" || seen.Get("Accept") == "" {
		t.Error("ordinary headers must survive")
	}
}

func TestTheBodyCannotCarryAContextOrAnotherTenant(t *testing.T) {
	w := newWorld(t)
	cases := map[string]string{
		"a context in the body":  `{"context":{"organization_id":"org_b","principal":"user:root","principal_kind":"USER"},"intent":{"id":"i1"}}`,
		"a principal in intent":  intentBody("sid_front-desk", `,"principal":"user:root"`),
		"a decision in intent":   intentBody("sid_front-desk", `,"decision":"allow"`),
		"a grant in the request": `{"grant":{"id":"g"},"intent":{"id":"i1"}}`,
	}
	for name, body := range cases {
		if r := w.do("agent", "POST", "/v1/actions/authorize", body); r.Code != 400 {
			t.Errorf("%s: %d %s", name, r.Code, r.Raw)
		}
	}
	if w.k.called("authorize") != 0 {
		t.Fatal("none of these may reach the kernel")
	}
	// naming another tenant is refused, not silently rewritten
	r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", `,"organization_id":"org_b"`))
	if r.Code != 403 || w.k.called("authorize") != 0 {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
	// naming the right tenant is fine, and absent means "mine"
	if r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", `,"organization_id":"org_a"`)); r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
}

// ── authentication ───────────────────────────────────────────────────────────

func TestUnauthenticatedCallsNeverReachTheKernel(t *testing.T) {
	w := newWorld(t)
	for name, hdr := range map[string][]string{
		"no header":      nil,
		"wrong scheme":   {"Authorization", "Basic abc"},
		"garbage":        {"Authorization", "Bearer nonsense"},
		"a hash":         {"Authorization", "Bearer " + auth.HashToken(w.tokens["agent"])},
		"almost correct": {"Authorization", "Bearer " + w.tokens["agent"] + "x"},
	} {
		r := w.do("", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", ""), hdr...)
		if r.Code != 401 || r.Header.Get("WWW-Authenticate") == "" {
			t.Errorf("%s: %d", name, r.Code)
		}
	}
	if len(w.k.calls) != 0 {
		t.Fatalf("the kernel was called: %v", w.k.calls)
	}
}

func TestRevokingATokenInTheFileTakesEffectAtOnce(t *testing.T) {
	w := newWorld(t)
	if r := w.do("agent", "GET", "/v1/health", ""); r.Code != 200 {
		t.Fatal(r.Code)
	}
	if err := os.WriteFile(w.file, []byte(`{"tokens":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if r := w.do("agent", "GET", "/v1/health", ""); r.Code != 401 {
		t.Fatalf("a removed token must stop working: %d", r.Code)
	}
}

func TestABrokenRegistryAuthenticatesNobodyAndIsNotReady(t *testing.T) {
	w := newWorld(t)
	if err := os.WriteFile(w.file, []byte(`{"tokens":[{"id":`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, who := range []string{"agent", "alice", "exec"} {
		if r := w.do(who, "GET", "/v1/health", ""); r.Code != 503 {
			t.Errorf("%s: %d", who, r.Code)
		}
	}
	if r := w.do("", "GET", "/readyz", ""); r.Code != 503 {
		t.Errorf("readyz: %d", r.Code)
	}
	if r := w.do("", "GET", "/healthz", ""); r.Code != 200 {
		t.Errorf("healthz is only about the process: %d", r.Code)
	}
}

func TestExpiredTokensAreRefused(t *testing.T) {
	w := newWorld(t)
	token, sha, _ := auth.NewToken()
	doc := `{"tokens":[{"id":"short","sha256":"` + sha + `","organization_id":"org_a","principal":"user:alice","kind":"user","roles":[],"expires_at":"2026-11-20T12:00:30Z"}]}`
	if err := os.WriteFile(w.file, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	w.tokens["short"] = token
	if r := w.do("short", "GET", "/v1/health", ""); r.Code != 200 {
		t.Fatalf("%d", r.Code)
	}
	w.now = w.now.Add(time.Minute)
	if r := w.do("short", "GET", "/v1/health", ""); r.Code != 401 {
		t.Fatalf("%d", r.Code)
	}
}

// ── who may propose ──────────────────────────────────────────────────────────

func TestWhoMayProposeAnAction(t *testing.T) {
	w := newWorld(t)
	type c struct {
		as, agent string
		want      int
	}
	for _, tc := range []c{
		{"agent", "sid_front-desk", 200}, // itself
		{"agent", "sid_rival", 403},      // not another agent
		{"rival", "sid_front-desk", 403},
		{"orch", "sid_front-desk", 200}, // an orchestrator for any agent in its tenant
		{"orch", "sid_rival", 200},
		{"alice", "sid_front-desk", 403}, // a person does not propose actions for an agent
		{"rita", "sid_front-desk", 403},
		{"exec", "sid_front-desk", 403}, // an executor is not a proposer
		{"plain", "sid_front-desk", 403},
	} {
		if r := w.do(tc.as, "POST", "/v1/actions/authorize", intentBody(tc.agent, "")); r.Code != tc.want {
			t.Errorf("%s proposing for %s: got %d, want %d (%s)", tc.as, tc.agent, r.Code, tc.want, r.Raw)
		}
	}
}

func TestAuthorizeAnswersInTheDocumentedShape(t *testing.T) {
	w := newWorld(t)
	w.k.authorize = func(in *kernelv1.AuthorizeActionRequest) (*kernelv1.AuthorizeActionResponse, error) {
		if in.Intent.OrganizationId != "org_a" || in.Intent.ArgumentsJson != `{"sku":"latte"}` || in.Intent.AmountMinor != 1200 || in.Intent.Risk != kernelv1.Risk_RISK_MEDIUM {
			t.Errorf("intent reached the kernel as %+v", in.Intent)
		}
		return &kernelv1.AuthorizeActionResponse{
			Decision: kernelv1.Decision_DECISION_REQUIRE_USER_CONFIRMATION, PendingId: "pending-1", Reasons: []string{"money"},
			Policy: &kernelv1.PolicyDecision{MatchedRule: "money-needs-confirmation", ReasonCodes: []string{"money_requires_confirmation"}, PolicyVersion: "v1"},
			// A buggy or hostile upstream attaching a grant to a non-ALLOW verdict must not get it forwarded.
			Grant: &kernelv1.Grant{Id: "leak"},
		}, nil
	}
	r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", ""))
	if r.Code != 200 || r.Body["decision"] != "require_user_confirmation" || r.Body["pending_id"] != "pending-1" {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
	if _, has := r.Body["grant"]; has {
		t.Fatalf("a grant must accompany ALLOW only: %s", r.Raw)
	}
	if r.Body["policy"].(map[string]any)["matched_rule"] != "money-needs-confirmation" {
		t.Fatal(r.Raw)
	}
}

func TestAnUnknownVerdictIsReadAsDeny(t *testing.T) {
	w := newWorld(t)
	w.k.authorize = func(*kernelv1.AuthorizeActionRequest) (*kernelv1.AuthorizeActionResponse, error) {
		return &kernelv1.AuthorizeActionResponse{Decision: kernelv1.Decision(99), Grant: &kernelv1.Grant{Id: "g"}}, nil
	}
	r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", ""))
	if r.Body["decision"] != "deny" || r.Body["grant"] != nil {
		t.Fatal(r.Raw)
	}
}

// ── who may answer a held action ─────────────────────────────────────────────

func TestWhoMayAnswerAHeldAction(t *testing.T) {
	type c struct {
		as, kind string
		approve  bool
		want     int
		kernel   bool // whether the kernel is asked to confirm
	}
	for _, tc := range []c{
		// a user confirmation is for the person the agent acts for
		{"alice", "user_confirmation", true, 200, true},
		{"bob", "user_confirmation", true, 404, false},  // another user in the same tenant cannot even see it
		{"rita", "user_confirmation", true, 403, false}, // a reviewer is not the owner
		{"zed", "user_confirmation", true, 404, false},  // another tenant: the kernel cannot find it (scripted below)
		{"agent", "user_confirmation", true, 403, false},
		{"exec", "user_confirmation", true, 403, false},
		{"orch", "user_confirmation", true, 403, false},
		// a human review is for a reviewer
		{"rita", "human_review", true, 200, true},
		{"alice", "human_review", true, 403, false}, // the owner alone is not a reviewer
		{"bob", "human_review", true, 404, false},   // bob may not even see it
		// declining is always safe for anyone who could have answered
		{"alice", "user_confirmation", false, 200, true},
		{"rita", "user_confirmation", false, 200, true},
		{"bob", "user_confirmation", false, 404, false},
	} {
		w := newWorld(t)
		w.k.pending = heldPending(tc.kind)
		if tc.as == "zed" {
			w.k.pending = nil // the kernel is tenant-scoped: org_b cannot see org_a's request
		}
		body := `{"approve":` + map[bool]string{true: "true", false: "false"}[tc.approve] + `}`
		r := w.do(tc.as, "POST", "/v1/actions/pending-1/confirm", body)
		if r.Code != tc.want {
			t.Errorf("%s answering %s approve=%v: got %d, want %d (%s)", tc.as, tc.kind, tc.approve, r.Code, tc.want, r.Raw)
		}
		if got := w.k.called("confirm") > 0; got != tc.kernel {
			t.Errorf("%s answering %s approve=%v: kernel asked to confirm = %v, want %v", tc.as, tc.kind, tc.approve, got, tc.kernel)
		}
	}
}

func TestTheConfirmationReachesTheKernelAsThatPersonAndOnlyThem(t *testing.T) {
	w := newWorld(t)
	w.k.pending = heldPending("user_confirmation")
	r := w.do("alice", "POST", "/v1/actions/pending-1/confirm", `{"approve":true}`, "X-Helix-Principal", "user:bob")
	if r.Code != 200 || r.Body["decision"] != "allow" {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
	ctx := w.k.last()
	if ctx.Principal != "user:alice" || ctx.PrincipalKind != kernelv1.PrincipalKind_PRINCIPAL_KIND_USER || ctx.OrganizationId != "org_a" {
		t.Fatalf("%+v", ctx)
	}
}

func TestWhoMayReadAHeldAction(t *testing.T) {
	w := newWorld(t)
	w.k.pending = heldPending("user_confirmation")
	for as, want := range map[string]int{"alice": 200, "rita": 200, "orch": 200, "bob": 404, "agent": 403, "exec": 404, "plain": 404} {
		if r := w.do(as, "GET", "/v1/actions/pending-1", ""); r.Code != want {
			t.Errorf("%s: %d, want %d", as, r.Code, want)
		}
	}
	r := w.do("alice", "GET", "/v1/actions/pending-1", "")
	if r.Body["kind"] != "user_confirmation" || r.Body["intent"].(map[string]any)["amount_minor"].(float64) != 1200 {
		t.Fatal(r.Raw)
	}
}

// ── execution, grants, identities ────────────────────────────────────────────

func TestOnlyAnExecutorBeginsAnExecution(t *testing.T) {
	body := `{"grant":{"id":"grant_1","format":"helix-grant/1","signature":"sig","single_use":true},"intent":` + intentObj("sid_front-desk") + `}`
	for as, want := range map[string]int{"exec": 200, "orch": 403, "agent": 403, "alice": 403, "reg": 403, "plain": 403} {
		w := newWorld(t)
		if r := w.do(as, "POST", "/v1/executions/begin", body); r.Code != want {
			t.Errorf("%s: %d, want %d (%s)", as, r.Code, want, r.Raw)
		}
	}
}

func TestABeginAnswerOnlyCarriesAnExecutionIdWhenPermitted(t *testing.T) {
	w := newWorld(t)
	body := `{"grant":{"id":"g"},"intent":` + intentObj("sid_front-desk") + `}`
	w.k.begin = func(*kernelv1.BeginExecutionRequest) (*kernelv1.BeginExecutionResponse, error) {
		return &kernelv1.BeginExecutionResponse{State: kernelv1.ExecutionState_EXECUTION_STATE_PENDING, ExecutionId: "exec_old", ResultJson: `{"order":"o_1"}`}, nil
	}
	r := w.do("exec", "POST", "/v1/executions/begin", body)
	if r.Body["state"] != "pending" || r.Body["execution_id"] != nil || r.Body["result"].(map[string]any)["order"] != "o_1" {
		t.Fatal(r.Raw)
	}
}

func TestRecordingAResult(t *testing.T) {
	w := newWorld(t)
	if r := w.do("exec", "POST", "/v1/executions/exec_1/result", `{"state":"succeeded","result":{"order":"o_9"}}`); r.Code != 200 || r.Body["receipt_hash"] != "abc" {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
	for name, body := range map[string]string{"pending is not recordable": `{"state":"pending","result":{}}`, "no state": `{"result":{}}`, "permitted": `{"state":"permitted"}`} {
		if r := w.do("exec", "POST", "/v1/executions/exec_1/result", body); r.Code != 400 {
			t.Errorf("%s: %d", name, r.Code)
		}
	}
	if r := w.do("alice", "POST", "/v1/executions/exec_1/result", `{"state":"succeeded","result":{}}`); r.Code != 403 {
		t.Errorf("a user must not record results: %d", r.Code)
	}
}

func TestRevocationNeedsTheRole(t *testing.T) {
	for as, want := range map[string]int{"admin": 200, "alice": 403, "rita": 403, "agent": 403, "exec": 403, "bob": 403} {
		w := newWorld(t)
		if r := w.do(as, "POST", "/v1/grants/grant_1/revoke", `{"reason":"lost"}`); r.Code != want {
			t.Errorf("%s: %d, want %d", as, r.Code, want)
		}
	}
}

func TestRegisteringAnAgentNeedsTheRegistrarRole(t *testing.T) {
	cert := `{"id":"sid_front-desk"}`
	for as, want := range map[string]int{"reg": 200, "exec": 403, "alice": 403, "agent": 403, "orch": 403} {
		w := newWorld(t)
		if r := w.do(as, "POST", "/v1/identities/verify", `{"certificate":`+cert+`,"register":true}`); r.Code != want {
			t.Errorf("%s register: %d, want %d", as, r.Code, want)
		}
	}
	w := newWorld(t)
	// verifying (without registering) is open to any authenticated caller
	for _, as := range []string{"agent", "alice", "exec"} {
		if r := w.do(as, "POST", "/v1/identities/verify", `{"certificate":`+cert+`}`); r.Code != 200 || r.Body["registered"] != false {
			t.Errorf("%s verify: %d %s", as, r.Code, r.Raw)
		}
	}
	if r := w.do("reg", "POST", "/v1/identities/verify", `{"register":true}`); r.Code != 400 {
		t.Errorf("a certificate is required: %d", r.Code)
	}
}

// ── hygiene ──────────────────────────────────────────────────────────────────

func TestBodyHygiene(t *testing.T) {
	w := newWorld(t)
	good := intentBody("sid_front-desk", "")
	big := `{"intent":{"id":"i1","agent_id":"sid_front-desk","capability":"c","risk":"low","idempotency_key":"k","arguments":{"blob":"` + strings.Repeat("a", 2<<20) + `"}}}`
	for name, tc := range map[string]struct {
		body, ctype string
		want        int
	}{
		"two documents":        {good + good, "application/json", 400},
		"trailing junk":        {good + " x", "application/json", 400},
		"empty":                {"", "application/json", 400},
		"not json":             {"{nope", "application/json", 400},
		"wrong content type":   {good, "text/plain", 415},
		"form content type":    {good, "application/x-www-form-urlencoded", 415},
		"no content type":      {good, "", 415},
		"a charset is fine":    {good, "application/json; charset=utf-8", 200},
		"oversized":            {big, "application/json", 413},
		"float amount":         {strings.Replace(good, `"amount_minor":1200`, `"amount_minor":12.5`, 1), "application/json", 400},
		"negative amount":      {strings.Replace(good, `"amount_minor":1200`, `"amount_minor":-5`, 1), "application/json", 400},
		"unknown risk":         {strings.Replace(good, `"risk":"medium"`, `"risk":"catastrophic"`, 1), "application/json", 400},
		"risk missing":         {strings.Replace(good, `"risk":"medium",`, ``, 1), "application/json", 400},
		"amount as a string":   {strings.Replace(good, `"amount_minor":1200`, `"amount_minor":"1200"`, 1), "application/json", 400},
		"arguments is a list":  {strings.Replace(good, `{"sku":"latte"}`, `["x"]`, 1), "application/json", 400},
		"intent is not object": {`{"intent":"allow"}`, "application/json", 400},
	} {
		req := httptest.NewRequest("POST", "/v1/actions/authorize", bytes.NewReader([]byte(tc.body)))
		if tc.ctype != "" {
			req.Header.Set("Content-Type", tc.ctype)
		}
		req.Header.Set("Authorization", "Bearer "+w.tokens["agent"])
		rec := httptest.NewRecorder()
		w.h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: got %d, want %d (%s)", name, rec.Code, tc.want, strings.TrimSpace(rec.Body.String()))
		}
	}
}

func TestNoSuchEndpointAndWrongMethod(t *testing.T) {
	w := newWorld(t)
	if r := w.do("agent", "GET", "/v1/nope", ""); r.Code != 404 {
		t.Errorf("%d", r.Code)
	}
	if r := w.do("agent", "POST", "/v1/health", "{}"); r.Code != 405 && r.Code != 404 {
		t.Errorf("%d", r.Code)
	}
	if r := w.do("agent", "DELETE", "/v1/actions/pending-1", ""); r.Code != 405 && r.Code != 404 {
		t.Errorf("%d", r.Code)
	}
}

// ── upstream errors ──────────────────────────────────────────────────────────

func TestKernelErrorsBecomeTheRightHTTPErrorsWithoutLeaking(t *testing.T) {
	for _, tc := range []struct {
		err   error
		code  int
		shows string // text that may appear in the answer; "" = the kernel's message must NOT appear
	}{
		{status.Error(codes.InvalidArgument, "intent.risk is required"), 400, "intent.risk is required"},
		{status.Error(codes.PermissionDenied, "only a person can confirm"), 403, "only a person can confirm"},
		{status.Error(codes.NotFound, "not found"), 404, "not found"},
		{status.Error(codes.FailedPrecondition, "already answered"), 409, "already answered"},
		{status.Error(codes.Unavailable, "dial tcp 10.0.0.7:50051: connection refused"), 503, ""},
		{status.Error(codes.DeadlineExceeded, "context deadline exceeded to 10.0.0.7"), 504, ""},
		{status.Error(codes.Internal, "sqlite: disk I/O error at /var/lib/helix/kernel.db"), 502, ""},
		{status.Error(codes.Unauthenticated, "certificate verify failed for CN=gateway"), 502, ""},
		{errors.New("plain error with secrets: hunter2"), 502, ""},
	} {
		w := newWorld(t)
		w.k.err = tc.err
		r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", ""))
		if r.Code != tc.code {
			t.Errorf("%v: got %d, want %d", tc.err, r.Code, tc.code)
		}
		if tc.shows != "" && !strings.Contains(r.Raw, tc.shows) {
			t.Errorf("%v: the kernel's message should reach the caller: %s", tc.err, r.Raw)
		}
		for _, secret := range []string{"10.0.0.7", "sqlite", "/var/lib", "hunter2", "CN=gateway"} {
			if tc.shows == "" && strings.Contains(r.Raw, secret) {
				t.Errorf("%v: leaked %q: %s", tc.err, secret, r.Raw)
			}
		}
	}
}

func TestReadyzFollowsTheKernel(t *testing.T) {
	w := newWorld(t)
	if r := w.do("", "GET", "/readyz", ""); r.Code != 200 {
		t.Fatal(r.Code)
	}
	w.k.err = status.Error(codes.Unavailable, "down")
	if r := w.do("", "GET", "/readyz", ""); r.Code != 503 || strings.Contains(r.Raw, "down") {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
}

// ── limits ───────────────────────────────────────────────────────────────────

func TestOneCallerCannotMonopoliseTheKernel(t *testing.T) {
	w := newWorld(t)
	w.srv.limiter = ratelimit.New(1, 3)
	w.srv.limiter.SetClock(func() time.Time { return w.now })
	codes := []int{}
	for i := 0; i < 5; i++ {
		codes = append(codes, w.do("agent", "GET", "/v1/health", "").Code)
	}
	if codes[0] != 200 || codes[2] != 200 || codes[3] != 429 || codes[4] != 429 {
		t.Fatalf("%v", codes)
	}
	if r := w.do("agent", "GET", "/v1/health", ""); r.Header.Get("Retry-After") == "" {
		t.Error("a 429 says when to come back")
	}
	// another caller is unaffected
	if r := w.do("alice", "GET", "/v1/health", ""); r.Code != 200 {
		t.Errorf("another principal was throttled: %d", r.Code)
	}
	// and the first recovers as time passes
	w.now = w.now.Add(2 * time.Second)
	if r := w.do("agent", "GET", "/v1/health", ""); r.Code != 200 {
		t.Errorf("%d", r.Code)
	}
}

func TestTooManyInFlightIsShedNotQueued(t *testing.T) {
	w := newWorld(t)
	w.srv = New(Config{Kernel: w.k, Auth: auth.Open(w.file, 0), RatePerSec: 1000, Burst: 1000, MaxInFlight: 2})
	w.h = w.srv.Handler()
	w.k.delay = 300 * time.Millisecond
	var wg sync.WaitGroup
	got := make(chan int, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got <- w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", "")).Code
		}()
	}
	wg.Wait()
	close(got)
	ok, shed := 0, 0
	for c := range got {
		switch c {
		case 200:
			ok++
		case 503:
			shed++
		}
	}
	if ok < 2 || shed < 1 {
		t.Fatalf("ok=%d shed=%d", ok, shed)
	}
}

func TestAPanicIsAGenericFiveHundred(t *testing.T) {
	w := newWorld(t)
	w.k.authorize = func(*kernelv1.AuthorizeActionRequest) (*kernelv1.AuthorizeActionResponse, error) {
		panic("boom: secret internal state")
	}
	r := w.do("agent", "POST", "/v1/actions/authorize", intentBody("sid_front-desk", ""))
	if r.Code != 500 || strings.Contains(r.Raw, "boom") || strings.Contains(r.Raw, "secret") {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
}

// ── plugins ──────────────────────────────────────────────────────────────────

func TestOnlyAPluginAdminServiceInstallsOrRemovesPlugins(t *testing.T) {
	body := `{"manifest":{"format":"helix-plugin/1"},"component_base64":"AGFzbQEAAAA="}`
	for as, want := range map[string]int{"deploy": 200, "alice": 403, "rita": 403, "admin": 403, "agent": 403, "orch": 403, "exec": 403, "plain": 403} {
		w := newWorld(t)
		if r := w.do(as, "POST", "/v1/plugins", body); r.Code != want {
			t.Errorf("%s install: %d, want %d (%s)", as, r.Code, want, r.Raw)
		}
		wantRemove := map[bool]int{true: 200, false: 403}[want == 200]
		if r := w.do(as, "DELETE", "/v1/plugins/acme.pricing", ""); r.Code != wantRemove {
			t.Errorf("%s remove: %d, want %d", as, r.Code, wantRemove)
		}
	}
}

func TestInstallPassesTheBytesExactlyAndTakesBigComponents(t *testing.T) {
	w := newWorld(t)
	comp := make([]byte, 6<<20) // bigger than any ordinary request body
	for i := range comp {
		comp[i] = byte(i * 7)
	}
	body := `{"manifest":{"format":"helix-plugin/1","id":"big"},"component_base64":"` + base64.StdEncoding.EncodeToString(comp) + `"}`
	r := w.do("deploy", "POST", "/v1/plugins", body)
	if r.Code != 200 || r.Body["installed"] != true {
		t.Fatalf("%d %s", r.Code, r.Raw[:min(200, len(r.Raw))])
	}
	if !bytes.Equal(w.k.lastComponent, comp) {
		t.Fatal("the component must reach the kernel byte for byte")
	}
	if !strings.Contains(w.k.lastManifest, `"id":"big"`) {
		t.Fatalf("manifest %q", w.k.lastManifest)
	}
	// but not without limit
	huge := `{"manifest":{},"component_base64":"` + strings.Repeat("A", 13<<20) + `"}`
	if r := w.do("deploy", "POST", "/v1/plugins", huge); r.Code != 413 {
		t.Fatalf("an oversized upload: %d", r.Code)
	}
	for name, bad := range map[string]string{
		"no component":  `{"manifest":{}}`,
		"not base64":    `{"manifest":{},"component_base64":"!!!"}`,
		"no manifest":   `{"component_base64":"AAAA"}`,
		"unknown field": `{"manifest":{},"component_base64":"AAAA","url":"https://evil.example/x.wasm"}`,
	} {
		if r := w.do("deploy", "POST", "/v1/plugins", bad); r.Code != 400 {
			t.Errorf("%s: %d", name, r.Code)
		}
	}
}

func TestAnyoneAuthenticatedCanListPlugins(t *testing.T) {
	w := newWorld(t)
	for _, as := range []string{"agent", "alice", "exec", "deploy"} {
		r := w.do(as, "GET", "/v1/plugins", "")
		if r.Code != 200 || len(r.Body["plugins"].([]any)) != 1 {
			t.Errorf("%s: %d %s", as, r.Code, r.Raw)
		}
	}
}

func TestWhoMayRunAPluginTool(t *testing.T) {
	for _, tc := range []struct {
		as, agent string
		want      int
	}{
		{"agent", "", 200}, {"agent", "sid_front-desk", 200}, {"agent", "sid_rival", 403},
		{"rival", "sid_front-desk", 403},
		{"orch", "sid_front-desk", 200},
		{"alice", "sid_front-desk", 403}, {"rita", "sid_front-desk", 403}, {"exec", "sid_front-desk", 403}, {"deploy", "sid_front-desk", 403}, {"plain", "sid_front-desk", 403},
	} {
		w := newWorld(t)
		body := `{"input":{"currency":"USD"}`
		if tc.agent != "" {
			body += `,"agent_id":"` + tc.agent + `"`
		}
		r := w.do(tc.as, "POST", "/v1/plugins/acme.pricing/tools/quote/invoke", body+"}")
		if r.Code != tc.want {
			t.Errorf("%s as %q: %d, want %d (%s)", tc.as, tc.agent, r.Code, tc.want, r.Raw)
		}
	}
}

func TestAPluginAnswerIsPassedOnAsProposalsNotDecisions(t *testing.T) {
	w := newWorld(t)
	r := w.do("agent", "POST", "/v1/plugins/acme.pricing/tools/checkout/invoke", `{"input":{"currency":"USD"}}`)
	if r.Code != 200 || r.Body["status"] != "ok" {
		t.Fatalf("%d %s", r.Code, r.Raw)
	}
	if r.Body["result"].(map[string]any)["total_minor"].(float64) != 1350 {
		t.Fatal(r.Raw)
	}
	intents := r.Body["proposed_intents"].([]any)
	if len(intents) != 1 || intents[0].(map[string]any)["capability"] != "merchant.order" {
		t.Fatal(r.Raw)
	}
	if _, has := r.Body["grant"]; has {
		t.Fatal("a plugin's answer never carries a grant")
	}
	// the kernel saw the plugin id and tool from the PATH, the caller from the TOKEN
	if w.k.lastInvoke.PluginId != "acme.pricing" || w.k.lastInvoke.Tool != "checkout" || w.k.last().Principal != "sid_front-desk" {
		t.Fatalf("%+v %+v", w.k.lastInvoke, w.k.last())
	}
	// when a limit stopped the tool nothing but the reason is passed on
	w.k.invoke = func(*kernelv1.InvokePluginRequest) (*kernelv1.InvokePluginResponse, error) {
		return &kernelv1.InvokePluginResponse{Status: "limit_exceeded", Limit: "fuel", Error: "the plugin ran out of fuel", ResultJson: `{"leak":1}`, ProposedIntentsJson: []string{`{"capability":"x"}`}}, nil
	}
	r = w.do("agent", "POST", "/v1/plugins/acme.pricing/tools/quote/invoke", `{"input":1}`)
	if r.Body["status"] != "limit_exceeded" || r.Body["limit"] != "fuel" || r.Body["result"] != nil || r.Body["proposed_intents"] != nil {
		t.Fatalf("%s", r.Raw)
	}
}
