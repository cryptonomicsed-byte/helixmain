# HelixMain MCP servers

Two stdio MCP servers. Both speak newline-delimited JSON-RPC 2.0 and are thin:
they decide nothing and duplicate no logic.

| server | file | what it is |
|---|---|---|
| `helix` | `helix-mcp.js` | the platform surface — voice / content / leads / site |
| `spark` | `spark-gate-mcp.js` | the SparkGatekeeper gate shim — one `invoke` tool |

## helix-mcp — the platform surface

The audit found the MCP surface was ~10% built: the foundry declared 7 `dna.*`
tools and *nothing served them*, and voice/content/leads/site were not invocable
at all. `helix-mcp` makes the platform drivable by any agent over one contract,
so the dashboard becomes one client of the same API rather than the only door.

Each tool is a **thin client of the local API** (`dna-foundry/api`, default
`http://127.0.0.1:3101`). The API owns extraction, metering, approval handoff and
generation; this server owns only the agent-facing shape and returns the API's
answer **verbatim**. It invents nothing — an unreachable API, a `402` budget cap
or a missing card all surface as an error with the real status.

| tool | endpoint | cost (credits) |
|---|---|---|
| `voice.call` | `POST /agent/session` | 5 (`playground_message`) |
| `content.generate` | `POST /content/prd` then `/content/generate` | 30 + 30 |
| `leads.discover` | `POST /sales/hunt` *(text)* or `/sales/hunt/gps` *(lat/lng)* | 20 |
| `site.publish` | `POST /site/generate` | 40 |

Arguments:

- `voice.call` — `companyId` (req), `message` (req), `role` (`front-desk` |
  `sales` | `content` | `owner-manager`), `cardId`. Runs one card-grounded turn;
  it does **not** place a PSTN call.
- `content.generate` — `companyId` (req), and **either** a ready `prd` **or**
  `goal` + non-empty `channels[]`. The PRD built in step 1 is the PRD sent to
  step 2 (no re-roll).
- `leads.discover` — `companyId` (req), plus `lat`/`lng`/`radiusMeters` (OSM
  path) or `industry`/`location`/`size`/`keywords` (Apollo path).
- `site.publish` — `companyId` (req). Returns `sitePath` (`/site/<companyId>`).

Env: `HELIX_API_URL` (default `http://127.0.0.1:3101`).

Run / test:

```sh
node dna-foundry/mcp/helix-mcp.js            # stdio server
npm test --prefix dna-foundry/mcp            # 24 tests (11 helix, 13 spark)
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
Omission is not a grant. Ready-to-apply snippet (NOT applied — it is a production
config change and needs an explicit go-ahead):

```toml
[[mcp.servers]]
name = "helix"
command = "/usr/local/bin/helix-mcp"     # symlink helix-mcp.js here
env = { HELIX_API_URL = "http://127.0.0.1:3101" }

[mcp_bundles.helix_platform]
servers = ["helix"]
```

Then add `mcp_bundles = ["helix_platform"]` to the `[agents.<alias>]` blocks that
should be able to drive the platform.

## Reachability

The API binds `127.0.0.1:3101`, so the MCP server must run where the API is
reachable (i.e. on the VPS host). To drive it from elsewhere, expose the API over
the tailnet (the same pattern as `paperclip-tailnet.socket`) and set
`HELIX_API_URL` to that address.

## One caveat worth knowing

The `free` tier is `monthly 100 / daily 20`. Several single operations cost more
than the daily cap — `site_generate` is 40, `campaign_prd` + `campaign_assets` is
60, `sales_qualify_bulk` is 25 — so a free-tier company is **permanently** blocked
from them, not merely rate-limited. Worth a look before it surprises a client.
