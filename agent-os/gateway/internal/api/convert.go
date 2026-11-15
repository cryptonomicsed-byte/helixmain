package api

import (
	"bytes"
	"encoding/json"
	"fmt"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
)

// intentJSON is the REST shape of kernel.v1.ActionIntent. organization_id is
// optional and, when present, must match the authenticated organisation.
type intentJSON struct {
	ID             string         `json:"id"`
	OrganizationID string         `json:"organization_id,omitempty"`
	AgentID        string         `json:"agent_id"`
	TaskID         string         `json:"task_id,omitempty"`
	Capability     string         `json:"capability"`
	Tool           string         `json:"tool,omitempty"`
	Target         string         `json:"target,omitempty"`
	Operation      string         `json:"operation,omitempty"`
	Risk           string         `json:"risk"`
	Arguments      map[string]any `json:"arguments,omitempty"`
	AmountMinor    int64          `json:"amount_minor,omitempty"`
	Currency       string         `json:"currency,omitempty"`
	IdempotencyKey string         `json:"idempotency_key"`
	Audience       string         `json:"audience,omitempty"`
}

var riskNames = map[string]kernelv1.Risk{
	"low": kernelv1.Risk_RISK_LOW, "medium": kernelv1.Risk_RISK_MEDIUM, "high": kernelv1.Risk_RISK_HIGH,
}

func riskName(r kernelv1.Risk) string {
	for k, v := range riskNames {
		if v == r {
			return k
		}
	}
	return "unspecified"
}

// compactJSON marshals without HTML escaping and without a trailing newline.
func compactJSON(v any) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return string(bytes.TrimRight(b.Bytes(), "\n")), nil
}

func (i *intentJSON) toPB() (*kernelv1.ActionIntent, error) {
	risk, ok := riskNames[i.Risk]
	if !ok {
		return nil, fmt.Errorf("risk must be low, medium or high")
	}
	if i.AmountMinor < 0 {
		return nil, fmt.Errorf("amount_minor must not be negative")
	}
	args := ""
	if i.Arguments != nil {
		var err error
		if args, err = compactJSON(i.Arguments); err != nil {
			return nil, fmt.Errorf("arguments are not valid JSON")
		}
	}
	return &kernelv1.ActionIntent{
		Id: i.ID, OrganizationId: i.OrganizationID, AgentId: i.AgentID, TaskId: i.TaskID,
		Capability: i.Capability, Tool: i.Tool, Target: i.Target, Operation: i.Operation,
		Risk: risk, ArgumentsJson: args, AmountMinor: i.AmountMinor, Currency: i.Currency,
		IdempotencyKey: i.IdempotencyKey, Audience: i.Audience,
	}, nil
}

func intentFromPB(i *kernelv1.ActionIntent) *intentJSON {
	if i == nil {
		return nil
	}
	out := &intentJSON{
		ID: i.Id, OrganizationID: i.OrganizationId, AgentID: i.AgentId, TaskID: i.TaskId,
		Capability: i.Capability, Tool: i.Tool, Target: i.Target, Operation: i.Operation,
		Risk: riskName(i.Risk), AmountMinor: i.AmountMinor, Currency: i.Currency,
		IdempotencyKey: i.IdempotencyKey, Audience: i.Audience,
	}
	if i.ArgumentsJson != "" {
		_ = json.Unmarshal([]byte(i.ArgumentsJson), &out.Arguments)
	}
	return out
}

// grantJSON is the REST shape of kernel.v1.Grant. It is returned to the
// requester and handed on, unchanged, to the executor, so it must round-trip
// every signed field.
type grantJSON struct {
	Format         string `json:"format"`
	ID             string `json:"id"`
	IssuerKid      string `json:"issuer_kid"`
	OrganizationID string `json:"organization_id"`
	Subject        string `json:"subject"`
	Audience       string `json:"audience"`
	Operation      string `json:"operation"`
	Target         string `json:"target"`
	MaxAmountMinor int64  `json:"max_amount_minor"`
	Currency       string `json:"currency"`
	IntentHash     string `json:"intent_hash"`
	NotBefore      string `json:"not_before"`
	ExpiresAt      string `json:"expires_at"`
	SingleUse      bool   `json:"single_use"`
	ParentID       string `json:"parent_id"`
	Signature      string `json:"signature"`
}

func grantFromPB(g *kernelv1.Grant) *grantJSON {
	if g == nil {
		return nil
	}
	return &grantJSON{
		Format: g.Format, ID: g.Id, IssuerKid: g.IssuerKid, OrganizationID: g.OrganizationId, Subject: g.Subject,
		Audience: g.Audience, Operation: g.Operation, Target: g.Target, MaxAmountMinor: g.MaxAmountMinor,
		Currency: g.Currency, IntentHash: g.IntentHash, NotBefore: g.NotBefore, ExpiresAt: g.ExpiresAt,
		SingleUse: g.SingleUse, ParentID: g.ParentId, Signature: g.Signature,
	}
}

func (g *grantJSON) toPB() *kernelv1.Grant {
	return &kernelv1.Grant{
		Format: g.Format, Id: g.ID, IssuerKid: g.IssuerKid, OrganizationId: g.OrganizationID, Subject: g.Subject,
		Audience: g.Audience, Operation: g.Operation, Target: g.Target, MaxAmountMinor: g.MaxAmountMinor,
		Currency: g.Currency, IntentHash: g.IntentHash, NotBefore: g.NotBefore, ExpiresAt: g.ExpiresAt,
		SingleUse: g.SingleUse, ParentId: g.ParentID, Signature: g.Signature,
	}
}

var decisionNames = map[kernelv1.Decision]string{
	kernelv1.Decision_DECISION_ALLOW:                     "allow",
	kernelv1.Decision_DECISION_DENY:                      "deny",
	kernelv1.Decision_DECISION_REQUIRE_USER_CONFIRMATION: "require_user_confirmation",
	kernelv1.Decision_DECISION_REQUIRE_HUMAN_REVIEW:      "require_human_review",
}

func decisionName(d kernelv1.Decision) string {
	if n, ok := decisionNames[d]; ok {
		return n
	}
	return "deny" // an unknown verdict is never read as permission
}

var stateNames = map[kernelv1.ExecutionState]string{
	kernelv1.ExecutionState_EXECUTION_STATE_PERMITTED: "permitted",
	kernelv1.ExecutionState_EXECUTION_STATE_PENDING:   "pending",
	kernelv1.ExecutionState_EXECUTION_STATE_SUCCEEDED: "succeeded",
	kernelv1.ExecutionState_EXECUTION_STATE_FAILED:    "failed",
	kernelv1.ExecutionState_EXECUTION_STATE_REFUSED:   "refused",
}

func stateName(s kernelv1.ExecutionState) string {
	if n, ok := stateNames[s]; ok {
		return n
	}
	return "refused"
}

type policyJSON struct {
	ID            string   `json:"id,omitempty"`
	MatchedRule   string   `json:"matched_rule"`
	ReasonCodes   []string `json:"reason_codes"`
	Reason        string   `json:"reason"`
	PolicyVersion string   `json:"policy_version"`
	DecidedAt     string   `json:"decided_at"`
}

type authorizeResponse struct {
	Decision  string      `json:"decision"`
	PendingID string      `json:"pending_id,omitempty"`
	Reasons   []string    `json:"reasons"`
	Policy    *policyJSON `json:"policy,omitempty"`
	Grant     *grantJSON  `json:"grant,omitempty"`
}

func authorizeResponseFromPB(r *kernelv1.AuthorizeActionResponse) authorizeResponse {
	out := authorizeResponse{Decision: decisionName(r.Decision), PendingID: r.PendingId, Reasons: nonNil(r.Reasons), Grant: grantFromPB(r.Grant)}
	// A grant accompanies ALLOW only. Never forward one with any other verdict.
	if out.Decision != "allow" {
		out.Grant = nil
	}
	if p := r.Policy; p != nil {
		out.Policy = &policyJSON{ID: p.Id, MatchedRule: p.MatchedRule, ReasonCodes: nonNil(p.ReasonCodes), Reason: p.Reason, PolicyVersion: p.PolicyVersion, DecidedAt: p.DecidedAt}
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
