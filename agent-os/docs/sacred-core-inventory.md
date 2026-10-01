# Sacred Core inventory: what becomes kernel, what stays dead

Source examined: `cryptonomicsed-byte/Sacred-core` (cloned 2026-10-01 to
~/workspace/repos/Sacred-core; TS/React marketing app). Also exists as
`Bino-Elgua/Sacred-core`; `Bino-Elgua/Full-Core` confirmed to exist (contents
not yet examined).

Principle: Sacred Core is **scrap for the kernel, not the kernel.** We extract
patterns and a few modules; we do not fork the app.

## Extract → kernel candidates

| File | Becomes |
|---|---|
| `services/llmProviderService.ts` (393 lines) | Model gateway: multi-provider (Gemini, OpenAI, Anthropic, Mistral, Groq, DeepSeek) with fallback |
| `services/inferenceRouter.ts` (113) | Request routing: fast / reasoning / verification modes |
| `services/universalAiService.ts` (341) | Provider-agnostic `complete()` surface (predecessor of `ModelGateway.complete`) |
| `services/costTrackingService.ts` (316) + `services/quotaService.ts` | Cost engine: per-action/per-tenant accounting → feeds receipt `cost_usd` |
| `services/authService.ts` (174) + `server.ts` JWT/bcrypt | Auth/session patterns for kernel identity (not the SQLite store itself) |
| `services/multiTenantService.ts` (324) | Tenancy isolation patterns |
| `services/featureFlagService.ts` (258) | Capability flags per tenant/agent |
| `services/healthCheckService.ts` (100) + `services/performanceMonitoringService.ts` | Runtime health + provider latency/failure tracking |
| `services/n8nService.ts` (96) + `services/webhookService.ts` (251) | Integration registry seed: workflow glue + inbound events |
| `services/enhancedExtractionService.ts` + `services/geminiService.ts` | Brand/DNA extractor → becomes the tenant's DNA card compiler input (policy + knowledge seed), not a marketing feature |

## Stay dead (do not port)

Campaigns, image/video generation providers, campaign PRD/sequencing, social
posting, lead scraping UI, SSO buttons, Stripe credits, the marketing dashboard
UI, `App.tsx` and all `pages/`/`components/` (except DNAHelix as a *design
reference* for the DNA card view).

## Gaps Sacred Core does NOT fill (must build)

- **No MCP** anywhere in `services/` (grep confirms). The MCP gateway is new work.
- No policy engine, no receipts, no event ledger, no worker abstraction.
- No pgvector/RAG, no ticket/CRM adapters (its "CRM" is lead management only).
- No telephony.

## Next step

Phase 1 spike: lift `llmProviderService` + `costTrackingService` patterns into
`kernel/` as `ModelGateway` and `CostEngine`, re-typed against
`contracts/receipt.json` (`cost_usd`) rather than the marketing quota model.
