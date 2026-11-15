package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/auth"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
)

// ── unauthenticated ──────────────────────────────────────────────────────────

// healthz says the gateway process is up. It says nothing else.
func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// readyz says whether the gateway can do its job: it can authenticate callers
// and reach the kernel. No details, since it is unauthenticated.
func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	reg, _ := s.auth.Current()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if reg == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	if _, err := s.kernel.Health(ctx, &kernelv1.HealthRequest{}); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// ── health ───────────────────────────────────────────────────────────────────

func (s *Server) health(w http.ResponseWriter, r *http.Request, _ caller) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	h, err := s.kernel.Health(ctx, &kernelv1.HealthRequest{})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"gateway": "ok", "kernel": h.Status, "kernel_version": h.Version, "policy_available": h.PolicyAvailable,
		"audit_entries": h.AuditEntries, "audit_head": h.AuditHead,
	})
}

// ── propose, hold, answer ────────────────────────────────────────────────────

type authorizeRequest struct {
	Intent intentJSON `json:"intent"`
}

// authorize: an agent may propose its own actions; an orchestrating service
// with the proposer role may propose for any agent of its tenant. A user may not.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, c caller) {
	p := c.P
	if !(p.Kind == auth.KindAgent || (p.Kind == auth.KindService && p.Has(auth.RoleProposer))) {
		forbid(w, "only an agent, or a service with the proposer role, may propose an action")
		return
	}
	var body authorizeRequest
	if !decode(w, r, &body) {
		return
	}
	if body.Intent.OrganizationID != "" && body.Intent.OrganizationID != p.Org {
		forbid(w, "the intent names another organization")
		return
	}
	body.Intent.OrganizationID = p.Org
	if p.Kind == auth.KindAgent && body.Intent.AgentID != p.ID {
		forbid(w, "an agent may only propose its own actions")
		return
	}
	intent, err := body.Intent.toPB()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, p)
	defer cancel()
	resp, err := s.kernel.AuthorizeAction(ctx, &kernelv1.AuthorizeActionRequest{Context: kctx, Intent: intent})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	out := authorizeResponseFromPB(resp)
	s.m.Counter("helix_gateway_decisions_total", "Authorization decisions returned.", 1, "decision", out.Decision, "phase", "authorize")
	writeJSON(w, http.StatusOK, out)
}

type pendingResponse struct {
	PendingID   string      `json:"pending_id"`
	Kind        string      `json:"kind"`
	State       string      `json:"state"`
	Intent      *intentJSON `json:"intent"`
	CreatedAt   string      `json:"created_at"`
	ExpiresAt   string      `json:"expires_at"`
	ReasonCodes []string    `json:"reason_codes"`
	// Set only when a person approved it AND the caller is the service that proposed the action.
	Grant *grantJSON `json:"grant,omitempty"`
}

func (s *Server) readPending(ctx context.Context, kctx *kernelv1.RequestContext, id string) (*kernelv1.GetPendingResponse, error) {
	return s.kernel.GetPending(ctx, &kernelv1.GetPendingRequest{Context: kctx, PendingId: id})
}

// mayAnswer decides who may answer a held decision. The kernel only knows that
// an answer comes from a USER; which user is the gateway's business:
//
//   - a user confirmation is answered by an OWNER of the agent, the person it acts for;
//   - a human review is answered by a user with the REVIEWER role.
//
// Anyone who may answer may also decline. Declining is always safe.
func mayAnswer(c caller, pending *kernelv1.GetPendingResponse, approve bool) bool {
	if c.P.Kind != auth.KindUser {
		return false
	}
	owner := c.Reg.IsOwner(c.P.Org, pending.GetIntent().GetAgentId(), c.P.ID)
	reviewer := c.P.Has(auth.RoleReviewer)
	if !approve {
		return owner || reviewer
	}
	switch pending.Kind {
	case "user_confirmation":
		return owner
	case "human_review":
		return reviewer
	}
	return false
}

func mayView(c caller, pending *kernelv1.GetPendingResponse) bool {
	switch c.P.Kind {
	case auth.KindUser:
		return c.Reg.IsOwner(c.P.Org, pending.GetIntent().GetAgentId(), c.P.ID) || c.P.Has(auth.RoleReviewer)
	case auth.KindService:
		return c.P.Has(auth.RoleProposer)
	}
	return false
}

func (s *Server) getPending(w http.ResponseWriter, r *http.Request, c caller) {
	if c.P.Kind == auth.KindAgent {
		forbid(w, "an agent cannot read held decisions")
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	p, err := s.readPending(ctx, kctx, r.PathValue("pending_id"))
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	if !mayView(c, p) {
		// Same answer as "no such request": do not reveal what exists.
		writeError(w, http.StatusNotFound, "not_found", "no such request")
		return
	}
	writeJSON(w, http.StatusOK, pendingResponse{
		PendingID: p.PendingId, Kind: p.Kind, State: p.State, Intent: intentFromPB(p.Intent),
		CreatedAt: p.CreatedAt, ExpiresAt: p.ExpiresAt, ReasonCodes: nonNil(p.ReasonCodes), Grant: grantFromPB(p.Grant),
	})
}

type confirmRequest struct {
	Approve bool `json:"approve"`
}

func (s *Server) confirm(w http.ResponseWriter, r *http.Request, c caller) {
	if c.P.Kind != auth.KindUser {
		forbid(w, "only a person can answer a held action")
		return
	}
	var body confirmRequest
	if !decode(w, r, &body) {
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	id := r.PathValue("pending_id")
	p, err := s.readPending(ctx, kctx, id)
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	if !mayAnswer(c, p, body.Approve) {
		if !mayView(c, p) {
			writeError(w, http.StatusNotFound, "not_found", "no such request")
			return
		}
		why := "you are not the person this agent acts for"
		if p.Kind == "human_review" {
			why = "this action needs a review by a user with the reviewer role"
		}
		forbid(w, why)
		return
	}
	resp, err := s.kernel.ConfirmAction(ctx, &kernelv1.ConfirmActionRequest{Context: kctx, PendingId: id, Approve: body.Approve})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	out := authorizeResponseFromPB(resp)
	s.m.Counter("helix_gateway_decisions_total", "Authorization decisions returned.", 1, "decision", out.Decision, "phase", "confirm")
	writeJSON(w, http.StatusOK, out)
}

// ── execution ────────────────────────────────────────────────────────────────

type beginRequest struct {
	Grant  grantJSON  `json:"grant"`
	Intent intentJSON `json:"intent"`
}

type beginResponse struct {
	State       string          `json:"state"`
	ExecutionID string          `json:"execution_id,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Reasons     []string        `json:"reasons"`
}

func requireExecutor(w http.ResponseWriter, c caller) bool {
	if c.P.Kind != auth.KindService || !c.P.Has(auth.RoleExecutor) {
		forbid(w, "only a service with the executor role may do this")
		return false
	}
	return true
}

func (s *Server) beginExecution(w http.ResponseWriter, r *http.Request, c caller) {
	if !requireExecutor(w, c) {
		return
	}
	var body beginRequest
	if !decode(w, r, &body) {
		return
	}
	if body.Intent.OrganizationID != "" && body.Intent.OrganizationID != c.P.Org {
		forbid(w, "the intent names another organization")
		return
	}
	body.Intent.OrganizationID = c.P.Org
	intent, err := body.Intent.toPB()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.BeginExecution(ctx, &kernelv1.BeginExecutionRequest{Context: kctx, Grant: body.Grant.toPB(), Intent: intent})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	out := beginResponse{State: stateName(resp.State), ExecutionID: resp.ExecutionId, Reasons: nonNil(resp.Reasons)}
	s.m.Counter("helix_gateway_executions_total", "Execution permits by state.", 1, "state", out.State)
	if resp.ResultJson != "" && json.Valid([]byte(resp.ResultJson)) {
		out.Result = json.RawMessage(resp.ResultJson)
	}
	// Only a PERMITTED state carries an execution id the executor may act on.
	if out.State != "permitted" {
		out.ExecutionID = ""
	}
	writeJSON(w, http.StatusOK, out)
}

type resultRequest struct {
	State  string `json:"state"`
	Result any    `json:"result"`
}

func (s *Server) recordResult(w http.ResponseWriter, r *http.Request, c caller) {
	if !requireExecutor(w, c) {
		return
	}
	var body resultRequest
	if !decode(w, r, &body) {
		return
	}
	var state kernelv1.ExecutionState
	switch body.State {
	case "succeeded":
		state = kernelv1.ExecutionState_EXECUTION_STATE_SUCCEEDED
	case "failed":
		state = kernelv1.ExecutionState_EXECUTION_STATE_FAILED
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", `state must be "succeeded" or "failed"`)
		return
	}
	result, err := compactJSON(body.Result)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "result is not valid JSON")
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.RecordResult(ctx, &kernelv1.RecordResultRequest{Context: kctx, ExecutionId: r.PathValue("execution_id"), State: state, ResultJson: result})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": stateName(resp.State), "receipt_hash": resp.ReceiptHash})
}

// ── grants and identities ────────────────────────────────────────────────────

type revokeRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) revokeGrant(w http.ResponseWriter, r *http.Request, c caller) {
	if !c.P.Has(auth.RoleGrantAdmin) {
		forbid(w, "revoking a grant needs the grant_admin role")
		return
	}
	var body revokeRequest
	if !decode(w, r, &body) {
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.RevokeGrant(ctx, &kernelv1.RevokeGrantRequest{Context: kctx, GrantId: r.PathValue("grant_id"), Reason: body.Reason})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": resp.Revoked})
}

type verifyRequest struct {
	Certificate json.RawMessage `json:"certificate"`
	Runtime     json.RawMessage `json:"runtime,omitempty"`
	Register    bool            `json:"register,omitempty"`
}

func (s *Server) verifyIdentity(w http.ResponseWriter, r *http.Request, c caller) {
	var body verifyRequest
	if !decode(w, r, &body) {
		return
	}
	if body.Register && !(c.P.Kind == auth.KindService && c.P.Has(auth.RoleRegistrar)) {
		forbid(w, "only a service with the registrar role may register an agent")
		return
	}
	if len(body.Certificate) == 0 || string(body.Certificate) == "null" {
		writeError(w, http.StatusBadRequest, "invalid_request", "certificate is required")
		return
	}
	runtime := ""
	if len(body.Runtime) > 0 && string(body.Runtime) != "null" {
		runtime = string(body.Runtime)
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.VerifyIdentity(ctx, &kernelv1.VerifyIdentityRequest{
		Context: kctx, CertificateJson: string(body.Certificate), RuntimeJson: runtime, Register: body.Register,
	})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": resp.Ok, "trusted": resp.Trusted, "errors": nonNil(resp.Errors), "untrusted": nonNil(resp.Untrusted),
		"sid": resp.Sid, "acting_hash": resp.ActingHash, "registered": resp.Registered,
	})
}
