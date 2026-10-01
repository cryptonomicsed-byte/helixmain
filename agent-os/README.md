# Agent OS — HelixMain's platform

> We install an AI workforce into an existing company and connect it to the
> company's systems, workflows, knowledge, and people.

The business is HelixMain (AI consulting/services for local small businesses).
The platform underneath it is this Agent OS. The consulting business is the
deployment mechanism; the platform is the moat.

## The one sentence

Paperclip gives organizational orchestration; Hermes gives agents cognition;
Grok Bots and Muse provide specialized workers; Sacred Core supplies governance
scrap; MCP connects the outside world; the action/receipt loop provides the
execution and accountability protocol. **One Agent OS with adapters, not five
systems glued together.**

## Layout

```text
agent-os/
  contracts/          # JSON Schema for the 13 nouns — the product's API of record
  docs/
    decision-memo-paperclip.md   # control plane: adopt vs reimplement (recommends adopt)
    risk-table-cs.md             # auto / approve / escalate policy seed for CS
    sacred-core-inventory.md     # what becomes kernel vs stays dead
  products/
    customer-service/ # first commercial agent (scaffold next)
  kernel/             # identity, tenancy, policy, receipts, events, costs (Phase 1)
  control-plane/      # Paperclip adapter (Phase 2)
  runtimes/hermes/    # RuntimeAdapter (Phase 3)
  workers/            # native_api now; grok-bot, muse, human later (Phase 4)
  apps/operator/      # operator dashboard (Phase 4-5)
```

## Contracts (frozen 2026-10-01, v0.1)

Organization → AgentIdentity → Goal → Task → ActionProposal → PolicyDecision
(allow | deny | approval_required) → WorkerInvocation → ToolResult →
Verification → Receipt. Plus CanonicalMemory (tenant-scoped, skills graduate
only after review) and LedgerEvent (append-only; receipts hang off it).

Workers and runtimes sit behind interfaces:

```text
RuntimeAdapter.execute(task, context) → RuntimeTrace
WorkerAdapter.execute(invocation)     → WorkerResult
ModelGateway.complete(req)            → ModelResult + cost
```

## What we do NOT build

Our own foundation model, browser, computer-use model, CRM, ERP, ticketing,
vector DB, 50 integrations, marketplace, blockchain consensus, custom language.
The value is the coordination and governance layer.

## Commercial progression

AI Customer Service Employee → Support Department → Sales + Support →
Operations → AI Workforce → AI Operating System. We start selling after the
first production vertical.

## Phase 0 exit criteria

1. Contracts reviewed (this repo).
2. Risk table signed.
3. Paperclip decision made (memo recommends adopt).
4. Sacred Core extract list done (inventory above).
5. Adapter spike proves: Task → Hermes plan → policy gate → native tool →
   receipt → task closed.
