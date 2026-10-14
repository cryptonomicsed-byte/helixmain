# Settings refactor: per-card + account, with MCP as a first-class surface

Date: 2026-10-14. Every claim below was verified against the deployed code/config on the
VPS, not read off a doc. Where a doc disagreed, the code won and the doc was corrected.

## 1. What exists today

### Account settings — `/settings` (SettingsLayout.tsx), 4 sub-tabs

| tab | route | content |
|---|---|---|
| AI & Keys | `/settings` | account model & provider, account provider API keys (`SettingsPage.tsx`, 2 sections) |
| Portfolio | `/settings/portfolio` | the companies this account owns |
| Billing | `/settings/billing` | Stripe portal / credits |
| Approvals | `/settings/approvals` | the SparkGatekeeper hold queue; tab badge polls the live count every 5s |

Plus a `Sign out` action pinned to the right end of the sub-nav strip.

### Card settings — `/card/:id/settings` (card/SettingsTab.tsx), 3 sub-tabs

| tab | route | content |
|---|---|---|
| AI | `/card/:id/settings` | `AiTab.tsx`: monthly budget cap, business default (provider/model), per-aspect routing, per-business keys |
| Approvals | `.../approvals` | same queue, filtered by `card_id` |
| History | `.../history` | the card's hash-chained changelog |

### The MCP plumbing that already exists — and is invisible in the product

- **Servers** (`dna-foundry/mcp/`): `helix-mcp.js` serving **15 tools**, `spark-gate-mcp.js`
  serving `invoke`.
- **ZeroClaw registrations** (`/etc/zeroclaw/config.toml`): 4 servers defined —
  `spark`, `helix`, `spark_demo-barber`, `helix_readonly` — and 4 bundles —
  `card_agent_tools`→[spark], `helix_platform`→[helix], `demo-barber_tools`→[spark_demo-barber],
  `directory_tools`→[helix_readonly]. Agents: `santinos`, `helix`, `demo-barber`,
  `helix-directory`.
- **Per-agent tool control**: `deny_all_tools` + risk profiles (`card_agent`, `account_agent`).
  A `[[mcp.servers]]` entry only DEFINES a server; an agent connects only if its `mcp_bundles`
  names it — omission is not a grant.
- **Channel grants** (`services/channelGrants.ts`): derived from `card.operations.channels[]`,
  mapping each channel type to MCP tool names, all sends H-gated through SparkGatekeeper.
- **Approvals**: `/gk` proxied to `127.0.0.1:9100` — `GET /held`,
  `POST /held/:id/{deny,challenge,approve}` (WebAuthn, fail-closed).
- **Card writes are already governed**: `PATCH /cards/:id` does NOT mutate; it records a
  proposal and returns **202 pending**; `POST /cards/:id/proposals/:pid/confirm` applies it.
- **Per-company sidecar config pattern**: `/etc/helix/companies/<id>/ai.json`, managed by
  `services/settings.ts` (`getCompanyAi` / `saveCompanyAi` / `resolveModel` / `keyForProvider` /
  `budgetCreditsFor` / `publicCompanyAi`). This is the template the MCP store should copy.

## 2. The gaps — this is what "everything we need" actually means

1. **There is no MCP UI at all.** `grep -rn -i mcp dashboard/src/` → **0 hits**.
2. **`operations.channels` is display-only.** It renders as a read-only `Chips` list in
   `CardTab.tsx`. Nothing in the product can write it, so **channel grants are unconfigurable** —
   the one mechanism that already exists cannot be used.
3. **Two tool namespaces, unreconciled.** `helix-mcp` serves `voice_call`, `content_generate`,
   `leads_discover`, `site_publish`, `billing_status`, `analytics_query`, `crm_manage`,
   `directory_search`, `dna_extract`, `dna_get`, `dna_compile`, `dna_diff`,
   `dna_propose_change`, `dna_decide_proposal`, `dna_sense`. The grant layer names
   `telephony.answer`, `telephony.transfer`, `email.draft`, `email.send`, `sms.draft`,
   `sms.send`, `social.draft`, `social.post`.
   **Verified: all 8 of those channel tool names are served by NOTHING, and `tools.json` does
   not describe them either (0 matches).** So a channel can be "granted" a tool that cannot be
   invoked — the grant vocabulary is disconnected from the tool registry.
4. **No API can read MCP state.** Nothing lists servers, bundles, grants, or effective tools.
   The only MCP-adjacent endpoint is `GET /channels/:companyId` (read-only derivation).
5. **No per-card MCP store.** `ai.json` exists per company; there is no `mcp.json`.
6. **Servers cannot be attached/detached from the product.** Per-card MCP servers exist
   (`spark_demo-barber` is a working precedent) but only by hand-editing `config.toml`.
7. **Registration is per-SERVER, not per-tool** (tools are discovered via `tools/list` at
   connect time), so the UI must display **discovered** tools with a timestamp — a static list
   goes stale, which is exactly how the platform skill came to claim the 7 `dna.*` tools were
   "served by nothing" when they are in fact all served.

## 3. Target information architecture

### Card settings — `/card/:id/settings` (6 sub-tabs)

1. **Agent** — rename of today's AI tab (routing / budget / keys). No behaviour change.
2. **MCP** — the centrepiece (see §4).
3. **Channels** — an editor for `operations.channels[]`, the grant source. Per channel:
   type, handle, verified; shows which MCP tools it unlocks and that every send is gated.
4. **Voice** — formalises what is currently scattered as header buttons: the bound npub (read
   only), relay list, the `/call/<slug>` URL + QR, greeting/personality/donts, test call.
5. **Approvals** — unchanged, scoped to the card.
6. **History** — unchanged.

### Account settings — `/settings` (6 sub-tabs)

1. **AI & Keys** — unchanged.
2. **MCP** — the registry view (see §4).
3. **Portfolio**, 4. **Billing**, 5. **Approvals** — unchanged.
6. **Access** (optional) — passkeys/sessions, since the account is now the multi-card tenant.

## 4. The MCP panel — what it must show

Per card, the panel answers "what can THIS card's agent actually do, and with what?":

- **Effective servers** — from the card agent's bundle, each with a live reachability probe.
- **Discovered tools per server** — from a real `tools/list`, cached with a `fetched_at`.
- **Grant state per tool** — allowed / denied (`deny_all_tools`) / not-in-bundle, three
  distinct states, never a boolean.
- **Channel-derived grants** — from the card, each with `requiresApproval` and its live gate
  status (pending holds for this card).
- **Gap report** — the honest panel: tools granted but served by nothing, servers defined but
  in no bundle, tools declared in `tools.json` but not served.
- **Actions** — attach/detach a server, grant/revoke a tool. All governed (see §6).

Account level shows the whole registry: servers, bundles, which agents reference them, the
tool catalogue, health, and the external-client config (repo-root `.mcp.json` / stdio command).

## 5. Endpoints to add

| endpoint | purpose | cost |
|---|---|---|
| `GET /mcp/:companyId` | effective MCP state for one card (servers, bundle, grants, channels, effective tools, gaps) | 0 |
| `GET /mcp/catalog` | registry: all defined servers + live `tools/list` + which agents reference them | 0 |
| `GET /mcp/health` | per-server reachability + last-seen `runtime-trace.jsonl` connect line | 0 |
| `POST /mcp/:companyId/propose` | propose attach/detach/grant/revoke → **202 pending** | 0 |

Reads cost nothing — the charging set is exactly the routes calling `deductCredits`
(`grep -n 'deductCredits(companyId, "' dna-foundry/api/src/index.ts`). Do not invent a charge.

## 6. Storage and the write path

- **Per card**: `/etc/helix/companies/<id>/mcp.json` — the desired state. Same shape as
  `ai.json`, same manager pattern (`services/settings.ts` → `services/mcp.ts`).
- **Account/registry**: read from `config.toml` for truth; never cache it as the source.
- **Reconciler (host-side, not the API)**: reads desired state → edits
  `[[mcp.servers]]` / `[mcp_bundles.*]` in `/etc/zeroclaw/config.toml` → reloads ZeroClaw →
  verifies via the trace line ``MCP server `<name>` connected — N tool(s) available`` in
  `/etc/zeroclaw/data/state/runtime-trace.jsonl`.
  The API must never edit the daemon's config directly: it is a production config change, it
  needs consent, and a half-written config takes the agent runtime down.
- **Governed**: changes go through `propose → confirm` exactly like card edits, because a grant
  change is a capability change.

## 7. Closing the tool-namespace gap

Two honest options, and the UI must show which one is live:

- **(a) Serve them.** Wire the channel tools into `helix-mcp.js` as thin clients of routes that
  already exist: `email.send` → `POST /channels/email`, `social.post` → `POST /channels/social`.
  Both already H-gate. `draft` variants map to the draft/persist step.
- **(b) Declare them as not-yet-served.** Remove them from `CHANNEL_TOOLS` and surface them as
  roadmap, so the panel never claims a capability that cannot be invoked.

Either way `CHANNEL_TOOLS` and `tools.json` must agree with what `tools/list` actually returns.

## 8. Phasing

| phase | scope | risk |
|---|---|---|
| **P0** | `GET /mcp/:companyId` + read-only card MCP tab + gap report | none — pure read |
| **P1** | Channels editor (`operations.channels`) → propose → confirm. Kills gap #2 | low — card proposal path already exists and is governed |
| **P2** | Serve the channel tools (or declare them unserved). Kills gap #3 | low |
| **P3** | Attach/detach servers + per-tool grants via the reconciler | medium — production daemon config |
| **P4** | Account MCP registry tab + external-client config + health | low |

P0 alone is worth shipping: today nobody can see what a card's agent can reach.

## 9. Verification (what "done" must prove)

- Read the tool list from a live `tools/list`, never from `tools.json` or a doc.
- After P1/P2: the "granted but unserved" list is empty.
- After P3: prove a **revoked** tool is actually refused by the agent (not merely greyed out in
  the UI), and that a grant change **without** confirm leaves `config.toml` byte-identical.
- Add a call for a company with no key on disk — it must return the honest **401**, not an
  invented answer.
