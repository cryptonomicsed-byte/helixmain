# Decision memo: Paperclip as control plane vs Paperclip as spec

Date: 2026-10-01. Status: **recommended, awaiting Justin's sign-off.**

## The question

Do we adopt Paperclip (`paperclipai/paperclip` — "the open-source app everyone
uses to manage agents at work") as our running organizational control plane,
or do we treat it as a reference spec and reimplement companies/goals/tasks in
our own kernel?

## Option A — Paperclip as the control plane (recommended)

- We run Paperclip. Company, Agent, Goal, Task, Budget, heartbeats, approvals,
  multi-org isolation come from it on day one.
- Our Hermes runtime becomes **one more Paperclip agent adapter**
  (their model already supports `claude_local`, `codex_local`, `process`,
  `http` — ours looks like `helix_hermes`).
- We build around it: the policy engine, receipt minting, canonical memory,
  and the event ledger live in our kernel and wrap Paperclip's task lifecycle.
- Paperclip stays the **control plane, never the execution plane** — their own
  stated boundary.

**Cost:** we inherit their data model and task-lock semantics. If their
semantics chafe later, migration is real work.

## Option B — Paperclip as spec, our kernel as the plane

- We extract the data model (Company → Goal → Task → Agent → Budget) and
  single-assignee checkout semantics, then reimplement in our Postgres schema.
- Full control of the task state machine; no dependency on an external
  project's release cadence.

**Cost:** 2–3 extra weeks in Phase 2 re-deriving what already runs, plus the
reconciliation risk if we ever adopt Paperclip pieces later.

## Recommendation

**A.** The 8–12 week CS MVP only holds if we don't rebuild org/task
infrastructure. The single non-negotiable: **one source of truth for task
state.** If Paperclip owns tasks, our kernel must not keep a shadow task
table — it keeps receipts, policies, and memory that *reference* Paperclip
task IDs.

## Verification results (2026-10-01, all four substrates checked)

- **Paperclip**: CONFIRMED. `paperclipai/paperclip`, 95k stars, MIT, TypeScript.
  Companies, goals (`project_goals`), tasks (`issues`), agent assignment,
  budgets (`budget_policies`, `budget_incidents`), work approvals
  (`issue_approvals`, same-company asserted), heartbeats (the scheduling
  engine), persistent task state, multi-org isolation — all present in code.
  Soft spots: "org charts" is a README claim (only a UI export page found);
  "board approvals" is loose phrasing (that's the admin-claim flow).
- **Hermes adapter registry**: CONFIRMED — Paperclip's
  `builtin-adapter-types.ts` already includes `hermes_local`,
  `hermes_gateway`, `grok_local`, `gemini_local`, `opencode_local`, etc.
  Our runtime adapter follows an established pattern, not a new one.
- **NousResearch/hermes-paperclip-adapter**: exists (1.9k stars, MIT) and
  already registers `hermes_local`, syncs Paperclip + Hermes-native skills,
  and parses Hermes output into typed transcript entries. It is the reference
  implementation for our runtime adapter — but it was pushed 2026-04-04 and
  is 6 months stale relative to `hermes-agent` itself: compatibility check
  required before we build on it.
- **Option A stands**, strengthened: Paperclip natively supports Hermes as a
  worker type, and a working adapter already exists upstream.

## Open verification (in flight)

Substrate check on: Paperclip's actual adapter model and heartbeat
semantics; what "Hermes Agent" is in `NousResearch/hermes-paperclip-adapter`;
whether any open-source Hermes runtime matches the 47-tool/MCP/skills
description or whether that description is composite. If Paperclip's adapter
model can't express our policy gate, this memo flips to B.

## Hermes identity note (2026-10-01)

The architecture's "Hermes" is `NousResearch/hermes-agent` (250k stars,
Python, MIT: "the self-improving AI agent" — 30+ native tools per Nous's own
adapter README, 80+ skills, MCP support, multi-provider, FTS5 session search,
built-in cron). This is **not** Justin's GenTeam orchestrator teammate who
happens to also be named Hermes. The name collision is real and will confuse
everyone; in code and docs the runtime is `hermes_agent` (Nous) and the
teammate is the GenTeam slot.

Corrections to the architecture doc from verification:
- "47 built-in tools" is unsubstantiated; Nous claims 30+. Use 30+.
- `hermes-agent` is a CLI/TUI product, not a library runtime — integration
  means the subprocess/adapter pattern (the Nous adapter already does this).
  "Wrap, don't fork" isn't a preference; it's the only sane posture.
- MCP "tool filtering" is partial (toolset allowlisting via `enabledToolsets`).
- Full-Core is the same codebase family as Sacred-core (both package.json
  name it `sacred-core-upgraded`; `types.ts` carries `BrandDNA`). Its README
  claims "production ready" with compliance badges while Sacred-core's own
  README says "in development, not deployed" — treat the enterprise claims as
  marketing inflation. Canonical repo stays `cryptonomicsed-byte/Sacred-core`.
- xAI/Grok enterprise API surface: **not verified.** The doc schedules Phase 4
  on it without evidence. Keep Grok workers as stubs until the API surface is
  confirmed.
