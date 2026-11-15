package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/auth"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
)

// A plugin component is at most 8 MiB; as base64 inside JSON that is under 11 MiB.
const maxPluginBody = 12 << 20

type pluginToolJSON struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type pluginJSON struct {
	ID              string           `json:"id"`
	Version         string           `json:"version"`
	ComponentSHA256 string           `json:"component_sha256"`
	Tools           []pluginToolJSON `json:"tools"`
	Permissions     []string         `json:"permissions"`
	ExpiresAt       string           `json:"expires_at"`
}

func pluginFromPB(p *kernelv1.PluginInfo) pluginJSON {
	out := pluginJSON{ID: p.Id, Version: p.Version, ComponentSHA256: p.ComponentSha256, ExpiresAt: p.ExpiresAt, Permissions: nonNil(p.Permissions), Tools: []pluginToolJSON{}}
	for _, t := range p.Tools {
		out.Tools = append(out.Tools, pluginToolJSON{Name: t.Name, Description: t.Description})
	}
	return out
}

func requirePluginAdmin(w http.ResponseWriter, c caller) bool {
	if c.P.Kind != auth.KindService || !c.P.Has(auth.RolePluginAdmin) {
		forbid(w, "only a service with the plugin_admin role may do this")
		return false
	}
	return true
}

type installPluginRequest struct {
	Manifest        json.RawMessage `json:"manifest"`
	ComponentBase64 string          `json:"component_base64"`
}

// installPlugin: the kernel verifies the signature, the component hash, the
// imports and the limits; a refusal is a 200 with the reasons, like the kernel's.
func (s *Server) installPlugin(w http.ResponseWriter, r *http.Request, c caller) {
	if !requirePluginAdmin(w, c) {
		return
	}
	var body installPluginRequest
	if !decodeLimit(w, r, &body, maxPluginBody) {
		return
	}
	if len(body.Manifest) == 0 || string(body.Manifest) == "null" || body.ComponentBase64 == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "manifest and component_base64 are required")
		return
	}
	component, err := base64.StdEncoding.DecodeString(body.ComponentBase64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "component_base64 is not base64")
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.InstallPlugin(ctx, &kernelv1.InstallPluginRequest{Context: kctx, ManifestJson: string(body.Manifest), Component: component})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	out := map[string]any{"installed": resp.Installed, "problems": nonNil(resp.Problems), "replaced": resp.Replaced}
	if resp.Plugin != nil {
		out["plugin"] = pluginFromPB(resp.Plugin)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listPlugins(w http.ResponseWriter, r *http.Request, c caller) {
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.ListPlugins(ctx, &kernelv1.ListPluginsRequest{Context: kctx})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	list := []pluginJSON{}
	for _, p := range resp.Plugins {
		list = append(list, pluginFromPB(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"plugins": list})
}

func (s *Server) removePlugin(w http.ResponseWriter, r *http.Request, c caller) {
	if !requirePluginAdmin(w, c) {
		return
	}
	ctx, cancel, kctx := s.kernelCtx(r, c.P)
	defer cancel()
	resp, err := s.kernel.RemovePlugin(ctx, &kernelv1.RemovePluginRequest{Context: kctx, PluginId: r.PathValue("plugin_id")})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"removed": resp.Removed})
}

type invokePluginRequest struct {
	Input   json.RawMessage `json:"input"`
	AgentID string          `json:"agent_id,omitempty"`
}

// invokePlugin: an agent runs a tool as itself; a service with the proposer role
// runs one for a named agent. A person does not. The kernel then requires the
// agent to be live and to have declared plugin.<id>.<tool>.
func (s *Server) invokePlugin(w http.ResponseWriter, r *http.Request, c caller) {
	p := c.P
	if !(p.Kind == auth.KindAgent || (p.Kind == auth.KindService && p.Has(auth.RoleProposer))) {
		forbid(w, "only an agent, or a service with the proposer role, may run a plugin tool")
		return
	}
	var body invokePluginRequest
	if !decode(w, r, &body) {
		return
	}
	if p.Kind == auth.KindAgent && body.AgentID != "" && body.AgentID != p.ID {
		forbid(w, "an agent may only run tools as itself")
		return
	}
	input := string(body.Input)
	if input == "" {
		input = "null"
	}
	ctx, cancel, kctx := s.kernelCtx(r, p)
	defer cancel()
	resp, err := s.kernel.InvokePlugin(ctx, &kernelv1.InvokePluginRequest{
		Context: kctx, PluginId: r.PathValue("plugin_id"), Tool: r.PathValue("tool"), InputJson: input, AgentId: body.AgentID,
	})
	if err != nil {
		s.upstream(w, r, err)
		return
	}
	out := map[string]any{
		"status": resp.Status, "error": resp.Error, "limit": resp.Limit, "fuel_used": resp.FuelUsed, "millis": resp.Millis,
		"plugin_hash": resp.PluginHash, "logs": nonNil(resp.Logs),
	}
	if resp.Status == "ok" {
		if json.Valid([]byte(resp.ResultJson)) {
			out["result"] = json.RawMessage(resp.ResultJson)
		}
		intents := make([]json.RawMessage, 0, len(resp.ProposedIntentsJson))
		for _, i := range resp.ProposedIntentsJson {
			if json.Valid([]byte(i)) {
				intents = append(intents, json.RawMessage(i))
			}
		}
		// Proposals, not decisions: each still goes through POST /v1/actions/authorize.
		out["proposed_intents"] = intents
	}
	writeJSON(w, http.StatusOK, out)
}
