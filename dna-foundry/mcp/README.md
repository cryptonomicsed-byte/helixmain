# HelixMain MCP servers

Two stdio MCP servers. Both speak newline-delimited JSON-RPC 2.0 and are thin:
they decide nothing and duplicate no logic.

| server | file | what it is |
|---|---|---|
| `helix` | `helix-mcp.js` | the platform surface — voice / content / leads / site / billing / analytics / crm, plus the seven `dna.*` foundry tools |
| `spark` | `spark-gate-mcp.js` | the SparkGatekeeper gate shim — one `invoke` tool |

## helix-mcp — the platform surface

The audit found the MCP surface was ~10% built: the foundry declared 7 `dna.*`
tools and *nothing served them*, and voice/content/leads/site were not invocable
at all. `helix-mcp` makes the platform drivable by any agent over one contract, so
the dashboard becomes one client of the same API rather than the only door.

### Two worlds, two trust levels — do not conflate them

The server exposes two groups, and they are **not** the same card world:

- **API tools** — thin clients of the platform API (`dna-foundry/api`, default
  `http://127.0.0.1:3101`), carrying a per-company key (`x-api-key`, read from the
  company's own `api-keys.json` when not overridden). They resolve
  `/etc/helix/companies/<slug>`. The API owns the work; this server returns its
  answer **verbatim** and invents nothing — an unreachable API, a `402` budget cap
  or a missing card surface as a real error with the real status.
- **`dna.*` tools** — the foundry's own surface. They dispatch to
  `handlers.py`, which drives the foundry swarm + compiler locally against
  `dna-foundry/cards` and `api/data/cards`. They carry **no tenant key** and never
  reach the API. **A foundry card is not a platform company.**

### API tools

| tool | endpoint | cost (credits) |
|---|---|---|
| `voice.call` | `POST /agent/session` | 5 (`playground_message`) |
| `content.generate` | `POST /content/prd` then `/content/generate` | 30 + 30 |
| `leads.discover` | `POST /sales/hunt` *(text)* or `/sales/hunt/gps` *(lat/lng)* | 20 |
| `site.publish` | `POST /site/generate` | 40 |
| `billing.status` | `action=status` (default): `GET /metering/:id` + `/plan/:id` + `/metering/:id/history` · `config`: `GET /billing/config` · `checkout`: `POST /billing/checkout` · `portal`: `GET /billing/portal/:id` | 0 (only `checkout` writes — and it mints no credits) |
| `analytics.query` | `GET /analytics/:id?period=` (+ `/enriched`) | 0 (read) |
| `crm.manage` | reads: `GET /crm/contacts/:id`, `/crm/summary/:id`, `/crm/proposals/:id` · propose: `POST /crm/contacts`, `PATCH /crm/contacts/:contactId` (**202**) · apply: `POST /crm/proposals/:pid/confirm` / `/deny` | 0 |

**Cost note:** only voice / content / leads / site charge, because only those API
routes call `deductCredits`. The read tools wrap routes that do not, so they charge
nothing — that is the API's behaviour passed through, not a decision made here.
**Credits enter only through Stripe's webhook**, after a real payment; no tool here
can mint them, and the API's `POST /metering/topup/:id` route is deliberately not
exposed. **Write note:** the only tools that change platform state are `site.publish`
(a real build), `billing.status action=checkout` (a Stripe session), and `crm.manage`'s
propose→confirm pair — `crm.manage`'s `create`/`update` record a *proposal* (202) and
change nothing until an owner credential confirms it.

Arguments:

- `voice.call` — `companyId` (req), `message` (req), `role` (`front-desk` |
  `sales` | `content` | `owner-manager`), `cardId`. Runs one card-grounded turn;
  it does **not** place a PSTN call.
- `content.generate` — `companyId` (req), and **either** a ready `prd` **or**
  `goal` + non-empty `channels[]`. The PRD built in step 1 is the PRD sent to
  step 2 (no re-roll).
- `leads.discover` — `companyId` (req), plus `lat`/`lng`/`radiusMeters` (OSM
  path) or `industry`/`location`/`size`/`keywords` (Apollo path).
- `site.publish` — `companyId` (req). Returns the API's real public `url`
  (`https://helixmain.duckdns.org/b/<companyId>/`), charged only after a
  successful build.
- `billing.status` — `companyId` (req), `action` (`status` default | `config` |
  `checkout` | `portal`), optional `from`/`to` (status), `priceId` (checkout).
  `status` composes credits + latest plan + usage history; a company with no plan
  yet answers `plan: null` with `plan_http_status: 404` — a real answer, not an
  error. `checkout` returns the API's `checkoutUrl` verbatim (or the API's honest
  `"Stripe not configured"` + `mockUrl` when no Stripe key is set) and adds no
  credits.
- `analytics.query` — `companyId` (req), `period` (`day|week|month`, default
  week), `enriched` (bool). With `enriched`, note the API computes the **lead
  totals system-wide** (all companies), so treat those as platform numbers.
- `crm.manage` — `companyId` (req), `action` (`list` | `summary` | `by_stage` |
  `proposals` | `create` | `update` | `confirm` | `deny`), plus `stage` (by_stage),
  `contactId`/`note`/`updates`/`cardId`/`summary` (update), `contact` (create),
  `proposalId` (confirm/deny). **Mutations are proposals:** `create`/`update` return
  **202** with a `pending` proposal and change nothing; `confirm`/`deny` apply or
  discard it and need the **owner** credential (`x-owner-key`, read from the same
  tenant key file, or `HELIX_OWNER_KEY`). Read/propose actions spend no credits.
  **Caveat:** `crmLite` is in-memory only, so CRM contacts do not survive an API
  restart — a proposal can therefore outlive the contact it targets, and confirming
  a vanished contact is an honest 404.

### `dna.*` tools — the foundry surface

Served by dispatching to the existing `handlers.py` (never re-implemented here,
because there is no API route for `dna.sense`):

| tool | implementation |
|---|---|
| `dna.extract` | swarm `orchestrator.py extract --url --org --out` |
| `dna.get` | foundry card lookup (`cards/`, `api/data/cards/`) |
| `dna.compile` | compiler `dist/cli.js --card --out` |
| `dna.diff` | compiler `dist/cli.js --card --diff` |
| `dna.propose_change` | swarm `mutate.py propose` |
| `dna.decide_proposal` | swarm `mutate.py decide` |
| `dna.sense` | swarm `sense.py --org [--force]` |

These report **no** `http_status` — no HTTP happens. A local call is marked as such
rather than given a fabricated status code.

Env: `HELIX_API_URL`, `HELIX_API_KEY` (optional override), `HELIX_CARD_ROOT`,
`HELIX_PYTHON` (default `python3`), `HELIX_DNA_TIMEOUT_MS` (default 120000).

Run / test:

```sh
node dna-foundry/mcp/helix-mcp.js            # stdio server
npm test --prefix dna-foundry/mcp            # 33 tests (20 helix, 13 spark)
```

## Registering it

**Claude Code / generic MCP client** — `.mcp.json` at the repo root is already
checked in; a client that reads it (Claude Code, and most MCP clients) picks up
both servers. The `helix` entry runs `node dna-foundry/mcp/helix-mcp.js` from the
repo root.

**opencode / other** — equivalent: `command: node`, `args:
["dna-foundry/mcp/helix-mcp.js"]`, `env: { HELIX_API_URL }`.

**ZeroClaw** (`/etc/zeroclaw/config.toml`) — a server is only *defined* by
`[[mcp.servers]]`; an agent only *connects* if its `mcp_bundles` names it.
Omission is not a grant. **This is applied on the host:**

```toml
[[mcp.servers]]
name = "helix"
command = "/usr/local/bin/helix-mcp"
env = { HELIX_API_URL = "http://127.0.0.1:3101" }

[mcp_bundles.helix_platform]
servers = ["helix"]
```

Granted to `santinos`, `demo-barber`, `test-cafe` (not to the `helix` operator
agent — its `deny_all_tools` profile stays as-is).

**Adding tools needs no config change.** The bundle names the *server*; tools are
discovered via `tools/list`. Adding the billing/analytics/crm/dna tools required no
edit to `.mcp.json` or `config.toml` — only a ZeroClaw restart, after which the
trace reads `MCP server \`helix\` connected — 14 tool(s) available`.

## Reachability

The API binds `127.0.0.1:3101`, so the MCP server must run where the API is
reachable (i.e. on the VPS host). To drive it from elsewhere, expose the API over
the tailnet (the same pattern as `paperclip-tailnet.socket`) and set
`HELIX_API_URL` to that address.

## Metering note

The daily cap is a *soft* rate limit: `checkQuota` allows an operation whenever
any credit remains today — it does **not** compare the operation's cost to what
is left. A single op therefore always ran once; what `free`'s old `daily: 20`
actually prevented was *finishing a multi-op workflow in one day* (a campaign is
PRD 30 + assets 30 = 60). `free` is now `monthly 100 / daily 75` so a whole
workflow fits in a day, and a load-time invariant refuses to boot if any tier's
daily cap drops below the priciest workflow. The monthly cap is the real budget.
(The earlier "permanently blocked" claim was wrong — corrected here.)
