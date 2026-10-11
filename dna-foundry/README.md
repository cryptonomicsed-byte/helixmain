# Helix DNA Foundry

**HelixMain creates and maintains a business's CARD.md. The card is the
product; every agent is a consumer.**

A local business's website, reviews, hours, offerings, voice, policies —
extracted once into a versioned `CARD.md`, then kept in sync by a
sense → propose → gate → apply loop. Every agent HelixMain deploys for that
business (web chat, phone, email, social) reads the same card, so the
business speaks with one voice everywhere.

`CARD.md` is the primary surface: a human-readable markdown file with a
tamper-evident frontmatter envelope (format, id, version, previous_hash,
hash, status) and fixed sections. The JSON card is the **compiled machine
view** — the compiler round-trips both directions, and the frontmatter `hash`
covers the canonical JSON, so any edit to the md (or the JSON) is detectable.

## Architecture

```
swarm/                      Python — orchestration, agents, decisions
  orchestrator.py           extractor swarm: identity, voice, offerings,
                            customers, operations, policies, knowledge,
                            insights (+ competitor stub)
  model_gateway.py          Jev is the decider, the LLM is the writer.
                            decide(schema, state) -> {decision,
                            probabilities, confidence, provider}
                            Provider chain: Jev -> cheap LLM (structured
                            output) -> deterministic heuristic. The provider
                            is recorded on every decision: the audit trail.
  sense.py                  tiered maintenance loop (see crawl-cost-model.md)
  mutate.py                 dna_propose_change + Jev-scored policy gate +
                            hash-chained versions + changelog + receipts
compiler/                   TypeScript — the CARD.md compiler
  src/business-md.ts        emitBusinessMd: card -> md (canonical JSON hash)
  src/business-md-parse.ts  parseBusinessMd + verifyBusinessMd (tamper
                            detection); byte-identical round-trip
  src/cli.js                --roundtrip --verify-md --parse-md --diff --out
api/                        TypeScript — REST API (cards, jobs, versions)
mcp/                        MCP tools: dna_extract/compile/sense/propose_change/
                            decide_proposal + agent.identity/provenance/consent
apps/operator/              operator UI: CARD.md tab (rendered) | Card JSON
                            tab (compiled view) | Diff v1->v2 tab (line diff)
```

### Jev is the decider, the LLM is the writer

TypeSafe AI's **Jev** — a "System One Model": unstructured state in, typed
probabilistic decisions out, no string generation, 70–500ms, $0.042/MTok
input / output free. It sits on exactly the decisions, and only the decisions:

- **Tier 1 triage** ("did the page materially change? classify: hours /
  offering / redesign / new_content / noise") — a choice question; its
  calibrated confidence drives auto-apply vs escalate (< 0.5 escalates).
- **`dna_propose_change` verification** ("is this proposal supported by the
  evidence?") — a score question, 0–1; below 0.4 an auto-tier proposal is
  held for approval.
- **The policy gate** — a noul ("should this auto-apply?"); auto only on a
  confident True.

This is the property LLMs lack: **calibrated confidence** (overconfident,
inconsistent). Tier 2/3 extraction and prompt compilation stay on the LLM —
Jev can't generate strings.

Jev is in early access and we are not in it yet: every call site has an LLM
fallback (cheap model, structured output via `HELIX_MODEL_GATEWAY_URL`) and
then a deterministic heuristic, so the pipeline runs today with zero keys.
Set `TYPESAFE_API_KEY` and the decider goes live with no code changes; the
`decision_trail` on every proposal and receipt records which provider
decided and why a mutation auto-applied. The Jevons paradox is the business
case: decisions this cheap mean we verify *everything* — triage,
verification, and gating cost ~$0.03/mo for a 100-business fleet.

### Why polyglot

- **Python** for the swarm: orchestration, agents, HTTP, retries.
- **TypeScript** for the compiler and API: the canonical-JSON hashing must
  match Python byte-for-byte, and one language owning the contract surface
  (compiler + API + UI) keeps it honest.
- **WASM** (future): sandboxed extractor plugins — untrusted site parsers
  run in a capability-limited sandbox.
- **Go/Elixir** (future): scale-out path for the sense loop across fleets.

## Run

```sh
# 1. install
pip install -r swarm/requirements.txt   # stdlib only; nothing to install
cd compiler && npm install && npm run build && cd ..

# 2. full demo: extract v1 -> compile -> round-trip -> sense -> mutate v2 -> gate hold
./demo.sh
```

The demo prints the decision provider trail at every step
(`provider=heuristic` until `TYPESAFE_API_KEY` is set). It copies
`BUSINESS-v1.md` / `BUSINESS-v2.md` and sample cards into `apps/operator/`;
open that folder's `index.html` (or serve it) for the operator UI.

### Key CLIs

```sh
# extract + compile one business
python3 swarm/orchestrator.py --org acme-cafe --fixture swarm/fixtures/acme-cafe
node compiler/dist/cli.js --roundtrip --out compiled/<id>_v1

# maintenance loop (tiered: Tier 0 change detection -> Jev triage -> targeted extract)
python3 swarm/sense.py --org acme-cafe

# propose a mutation through the Jev-scored gate
python3 swarm/mutate.py propose --card dna_xxx --field operations.hours \
  --old '"Mon-Fri 7am-3pm"' --new '"Mon-Fri 7am-5pm"' --evidence sense:tier2
python3 swarm/mutate.py decide --proposal prop_xxx --approve

# MCP server (stdio)
python3 mcp/server.py
```

## Stubs (honest list)

- Jev provider: built against the real API shape
  (`POST https://api.typesafe.ai/v1/systemone`), but early access pending —
  heuristics decide until `TYPESAFE_API_KEY` is set.
- `extractor:competitor` is a wired stub (refuses to invent competitors
  without a search API).
- LLM extraction behind `HELIX_MODEL_GATEWAY_URL` — documented, not wired;
  heuristics extract today.
- Headless render for JS-heavy sites: `js_render` flag detected and cached,
  renderer not wired yet.
- Reviews: on-site testimonials only; no third-party review APIs.
- Compiler emits a RAG *manifest*, not a vector index.
- Operator UI is static (reads files written by demo.sh); API has no auth;
  job store is the filesystem.

## Contract

The card schema lives in the contract repo:
`~/workspace/helixmain/agent-os/contracts/dna-card.json` and the CARD.md
standard in `business-card-md-standard.md`. The compiler is tested
byte-identical against that contract (TS hash == Python hash, test vector in
`compiler/src/tests/business-md.test.ts`).
