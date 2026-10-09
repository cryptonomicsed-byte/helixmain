# HelixMain Feature Build TODO
> Sourced from: CoreDNA, Full-Core, Sacred-core, sacred-core-agency deep audit  
> Last updated: 2026-10-09

## Legend
- `[needs: ENV_VAR]` — env var required before this can run
- `🔒` — H-gate required: must pass through SparkGatekeeper hold queue before execution
- `(source: file)` — maps to audit file in source repos

---

## Phase 1 — Foundation (do first, unlocks everything)

- [ ] Persist in-memory stores (`leadStore`, `assetStore`, `prdStore`, `planStore`, `accountStore`) to JSON files under `/etc/helix/companies/{id}/` so data survives API restarts `(source: salesPipeline.ts, contentPipeline.ts, metering.ts)`
- [ ] Add OpenRouter as a named provider in `aiGateway.ts` — single key covers Mistral, DeepSeek, Gemini, and others as fallback gateway `(source: aiGateway.ts)` `[needs: OPENROUTER_API_KEY]`
- [ ] Add `mistral` provider branch to `callProvider()` in `aiGateway.ts` using OpenAI-compat shape at `https://api.mistral.ai/v1/chat/completions` `(source: aiGateway.ts)` `[needs: MISTRAL_API_KEY]`
- [ ] Extend neuralCache from 5-min in-memory TTL to SHA-256 keyed on-disk cache at `/etc/helix/cache/neural/` with configurable TTL via `NEURAL_CACHE_TTL_SECONDS` env var `(source: aiGateway.ts)`
- [ ] Wire `deductCredits()` / `refundCredits()` into every LLM-calling route — currently initialized but not enforced per-operation `(source: metering.ts, index.ts)`
- [ ] Update `CREDIT_COSTS` table in `metering.ts`: extraction=50, campaign=30, voice=15, agent=20/msg, website=40, jingle=25 `(source: metering.ts)`
- [ ] Replace `huntLeadsApollo()` + `huntLeadsHunter()` in `salesPipeline.ts` with `huntLeadsOSM()` — accepts `{ lat, lng, industry, radiusMeters }`, queries OpenStreetMap Overpass API (no key), returns leads with digital footprint score `(source: salesPipeline.ts)` `[needs: none]`
- [ ] Add self-healing retry wrapper in `contentPipeline.ts`: if `qualityScore < 40` on first generation, auto-regenerate once; on second failure set `status: "healing"` and log `(source: contentPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Extract contact info from website crawl in `extractor.ts`: after DOM parse, run regex pass for `mailto:`, `tel:`, and `@type:Person` JSON-LD — populates lead email/phone without Hunter.io `(source: extractor.ts)`
- [ ] Add Brand DNA 5-tone classification to `extractor.ts` LLM pass: `voice.tones[]` = exactly 5 items from `[bold, warm, playful, authoritative, minimal]` with confidence per tone `(source: extractor.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Add SWOT to `extractor.ts` output: `appendix.swot: { strengths[], weaknesses[], opportunities[], threats[] }` — stored in card appendix, never card identity `(source: extractor.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Add audience personas to `extractor.ts`: `appendix.personas[]: { name, age_range, pain_points[], channels[] }` — minimum 2, derived from offerings + voice tone `(source: extractor.ts)` `[needs: DEEPSEEK_API_KEY]`

---

## Phase 2 — Sales Motion (GPS → Lead → Close)

- [ ] Implement `POST /sales/hunt/gps` route: accepts `{ companyId, lat, lng, industry, radiusMeters? }`, calls `huntLeadsOSM()`, returns leads array with `digitalFootprintScore` `(source: salesPipeline.ts, index.ts)` `[needs: none]`
- [ ] Add `digitalFootprintScore` computation in `huntLeadsOSM()`: HEAD-request each business website — 0=no website, 30=site down, 60=live no social, 100=live + social detected `(source: salesPipeline.ts)`
- [ ] Add lead activity log endpoint `GET /sales/leads/:leadId/activity` — returns `lead.activityLog[]` sorted newest-first `(source: salesPipeline.ts, index.ts)`
- [ ] Add hot/warm/cold/disqualified tier to `qualifyLead()` LLM prompt — must return `tier` field alongside `score` and `signals[]`; persist tier to lead record `(source: salesPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Implement `generateClosingScript()` in `salesPipeline.ts`: returns `{ closingScript, objectionHandlers: Record<string,string>, urgencyTriggers[], proposalTiers: { starter, growth, dominate } }` `(source: salesPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Add `POST /sales/close/:leadId` route — calls `generateClosingScript()`, returns 3-tier proposal `(source: index.ts, salesPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Implement `generatePersonalizedOutreach()` that uses website-crawled contact info instead of requiring pre-populated email `(source: salesPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Audit `POST /sales/submit/:leadId` — confirm GK payload includes `{ action: "send_email", to, subject, body, companyId }` before enabling outreach button in UI `(source: index.ts, salesPipeline.ts)` `🔒`
- [ ] Build `LeadHunterPage.tsx`: lat/lng or address input, industry text, radius slider, results table with footprint score badges, one-click qualify button `(source: dashboard/src/pages/)`
- [ ] Build `SalesPipelinePage.tsx`: Kanban columns new/contacted/qualified/converted/lost, drag-to-move calls `PATCH /sales/leads/:leadId`, tier badge (hot/warm/cold) per lead card `(source: dashboard/src/pages/)`
- [ ] Add Battle Mode panel to `IntelPage.tsx` (new): two company selectors + "Run Battle" button, renders visual/messaging/positioning scores and gap list `(source: intelEngine.ts, dashboard/src/pages/)`

---

## Phase 3 — Content Engine (Campaign → Assets → Site)

- [ ] Add `TikTok` channel to `contentPipeline.ts` `Channel` type and `channelGrants.ts` `ChannelType` — currently missing from `CHANNEL_TOOLS` map `(source: contentPipeline.ts, channelGrants.ts)`
- [ ] Add LinkedIn asset prompt in `generateCampaignAssets()`: `{ headline, hook, body, cta }` structure distinct from Instagram caption `(source: contentPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Add email template asset type in `generateCampaignAssets()`: `{ subject, preheader, bodyHtml, cta }` when `assetType === "email"` `(source: contentPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Implement social scheduling store: `scheduleAsset(assetId, publishAt)` adds `scheduledAt` to `CampaignAsset`; loop in `index.ts` checks every minute and submits due assets to SparkGatekeeper `(source: contentPipeline.ts)` `🔒`
- [ ] Add `POST /content/schedule/:assetId` route: accepts `{ publishAt, companyId }`, calls `scheduleAsset()` `(source: index.ts)` `🔒`
- [ ] Implement `generateWebsite()` in new `siteGenerator.ts`: accepts card JSON, returns self-contained single-file HTML with inline CSS — sections: hero, offerings grid, tone-matched copy, contact block `(source: new service)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Add `POST /site/generate` and `GET /site/:companyId` routes in `index.ts` `(source: index.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Implement ZIP export in `businessPlan.ts`: bundle plan HTML + company images + card JSON → `.zip` buffer from `GET /plan/:companyId/zip` `(source: businessPlan.ts, index.ts)`
- [ ] Add campaign asset ZIP export `GET /content/campaign/:campaignId/zip` — bundles all `CampaignAsset` text files + images `(source: contentPipeline.ts, index.ts)`
- [ ] Build `CampaignPage.tsx`: goal input, channel multi-select, PRD preview accordion, asset cards per channel with approve-to-queue button per asset `(source: dashboard/src/pages/)` `🔒`
- [ ] Build `SchedulePage.tsx`: calendar view of scheduled assets, publish-time picker, status badges (draft/scheduled/in-queue/published), cancel button `(source: dashboard/src/pages/)` `🔒`

---

## Phase 4 — Voice & Agent (ElevenLabs → Sonic → OpenClaw)

- [ ] Implement `synthesizeElevenLabs()` in `voiceResolver.ts`: POST to `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`, return audio buffer as base64 `(source: voiceResolver.ts)` `[needs: ELEVENLABS_API_KEY]`
- [ ] Wire ElevenLabs path into `synthesizeSample()` dispatch in `voiceResolver.ts` — currently only Kokoro path exists `(source: voiceResolver.ts)` `[needs: ELEVENLABS_API_KEY]`
- [ ] Add `GET /voices/elevenlabs` route: fetches user's cloned + premade voices from ElevenLabs `/v1/voices` `(source: index.ts, voiceResolver.ts)` `[needs: ELEVENLABS_API_KEY]`
- [ ] Implement `generateJingle()` in new `sonicBranding.ts`: uses `voice.tones[]`, `identity.tagline`, `identity.name` to generate lyrics + BPM + mood brief, calls ElevenLabs sound generation endpoint, costs 25 credits `(source: new service)` `[needs: ELEVENLABS_API_KEY, DEEPSEEK_API_KEY]`
- [ ] Add `POST /voice/jingle` route in `index.ts` calling `generateJingle()` `(source: index.ts)` `[needs: ELEVENLABS_API_KEY]`
- [ ] Add `fastify-websocket` plugin, register `GET /agent/ws` WebSocket route that spawns an agent session with tool grants from `agentCompiler` output `(source: agentCompiler.ts, index.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Implement OpenClaw tool dispatcher: routes WebSocket tool-call messages to `scrape` (fetch URL → text), `email` (H-gate via GK), `research` (aiGateway call), `analyze` (aiGateway with card context) `(source: agentCompiler.ts)` `🔒`
- [ ] Add `post` and `website_gen` tool handlers — `post` submits to SparkGatekeeper; `website_gen` calls `generateWebsite()` `(source: agentCompiler.ts, siteGenerator.ts)` `🔒`
- [ ] Add `sonic_gen` tool handler that calls `generateJingle()` from within an agent session `(source: sonicBranding.ts, agentCompiler.ts)` `[needs: ELEVENLABS_API_KEY]`
- [ ] Build `VoiceStudioPage.tsx`: voice picker (Kokoro + ElevenLabs catalog), sample text input, preview play button, jingle generation trigger with progress indicator `(source: dashboard/src/pages/)`

---

## Phase 5 — Dashboard Upgrade (Analytics → Portfolio → Admin)

- [ ] Extend `AnalyticsSummary` in `analytics.ts` to include: `campaignsSent`, `assetClickthroughRate`, `totalOutreachEmails`, `leadsConverted` — aggregate from `assetStore` and `leadStore` `(source: analytics.ts)`
- [ ] Add `POST /analytics/event` route: accepts `{ companyId, eventType, assetId?, leadId?, metadata? }`, appends to per-company event log `(source: index.ts, analytics.ts)`
- [ ] Implement A/B variant generation: `generateVariants(prd, card, storyId, count=2)` creates N asset variants; `compareVariants(variantIds[])` returns side-by-side diff with tone score delta `(source: contentPipeline.ts)` `[needs: DEEPSEEK_API_KEY]`
- [ ] Add `POST /content/variants` and `POST /content/variants/compare` routes `(source: index.ts)`
- [ ] Upgrade `DashboardPage.tsx` metrics: replace stubs with live data from `GET /analytics/:companyId?period=week` — add charts for call volume, conversion funnel, top topics, credit spend over time `(source: dashboard/src/pages/DashboardPage.tsx)`
- [ ] Implement `portfolio.ts` service: `addAsset()`, `listAssets()`, `getAsset()` — aggregates cards, campaign assets, images, plans, generated sites per company into indexed manifest `(source: new service)`
- [ ] Add `GET /portfolio/:companyId` route `(source: index.ts)`
- [ ] Build `PortfolioPage.tsx`: tabbed by asset type (cards, campaigns, images, plans, sites), grid with created date + download/preview action per asset `(source: dashboard/src/pages/)`
- [ ] Add `GET /analytics/cache-stats` route: returns `{ neuralCache: { size, hitRate }, costLog: { totalUsd, byProvider } }` `(source: index.ts, costLog.ts)`
- [ ] Add system health panel to dashboard: polls service status for API (3101), SparkGatekeeper (9100), Kokoro TTS (8880), neuralCache hit rate `(source: dashboard/src/pages/)`
- [ ] Add `GET /playground/sessions/all` admin route (PIN-middleware protected) listing all active sessions across companies `(source: index.ts, playground.ts)`

---

## Phase 6 — Metering & Billing (Credits → Stripe → Affiliate)

- [ ] Persist `CreditAccount` to disk at `/etc/helix/companies/{id}/credits.json` — currently fully in-memory `(source: metering.ts)`
- [ ] Add Stripe webhook handler `POST /billing/webhook`: handles `checkout.session.completed` + `invoice.paid`, calls `topUpCredits(companyId, amount)` based on price ID lookup `(source: index.ts)` `[needs: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET]`
- [ ] Implement `PRICE_TO_CREDITS` map in `metering.ts`: Starter ($0/500cr), Pro ($49/2000cr), Enterprise ($199/10000cr) `(source: metering.ts)` `[needs: STRIPE_SECRET_KEY]`
- [ ] Add one-time credit packs to `PRICE_TO_CREDITS`: Spark ($4.99/150cr), Boost ($14.99/550cr), Power ($29.99/1200cr), Agency ($89.99/4000cr) `(source: metering.ts)` `[needs: STRIPE_SECRET_KEY]`
- [ ] Add `POST /billing/checkout` route: creates Stripe Checkout session for `priceId` + `companyId`, returns `{ checkoutUrl }` `(source: index.ts)` `[needs: STRIPE_SECRET_KEY]`
- [ ] Add `GET /billing/portal/:companyId` route: creates Stripe Customer Portal session URL `(source: index.ts)` `[needs: STRIPE_SECRET_KEY]`
- [ ] Add `GET /metering/:companyId/history` route: returns `usageLog[]` with optional `from`/`to` query params + running balance column `(source: metering.ts, index.ts)`
- [ ] Add `topUpCredits(companyId, credits, reason)` to `metering.ts`: appends positive `UsageEntry` with `creditsDeducted: -N` and updates balance `(source: metering.ts)`
- [ ] Implement `affiliate.ts` service: `generateReferralCode(companyId)`, `recordReferral(code, newCompanyId)` stores conversions `(source: new service)`
- [ ] Add `POST /affiliate/refer` and `GET /affiliate/:companyId` routes `(source: index.ts)` `[needs: none]`
- [ ] Implement commission calculation in `affiliate.ts`: on billing webhook, credit referrer 10% (free), 15% (pro), 20% (enterprise) of referred company's payment `(source: affiliate.ts)` `[needs: STRIPE_SECRET_KEY]`
- [ ] Build `BillingPage.tsx`: current balance, tier badge, usage history table, upgrade buttons (Stripe Checkout), credit pack buttons, referral link with copy-to-clipboard `(source: dashboard/src/pages/)`

---

## Do Not Build

| Item | Reason |
|------|--------|
| Video generation | No reliable free-tier provider; premature spend with no proven ROI |
| n8n workflow automation | Fastify + SparkGatekeeper IS the workflow layer; n8n duplicates it |
| Sentry error tracking | Single-tenant VPS; Fastify's built-in logger is sufficient |
| Hunter.io / Apollo | Replaced by website-crawl contact extraction; paid keys, data dependency |
| Realtime collaboration / cursor tracking | Requires CRDT/OT layer; card is a signed file not a shared doc |
| Statistical significance A/B | No sample sizes yet; build UI comparison view first |
| Social post stubs / simulated sonic / fake video | Never real — do not port from Gen1/Gen4 repos |
| Hardcoded API keys from lyriaService.ts | Rotate/disable; never port to HelixMain |

---

## Implementation Notes

**Primary LLM:** DeepSeek direct (`DEEPSEEK_API_KEY`) for cost  
**Fallback gateway:** OpenRouter (`OPENROUTER_API_KEY`) — one key covers Gemini, Mistral, Groq, etc.  
**GPS leads:** OpenStreetMap Overpass API — free, no key, no billing  
**Contact extraction:** website crawl (`mailto:` / `tel:` / JSON-LD) — no Hunter.io  
**TTS:** Kokoro (live on VPS) for default; ElevenLabs for premium/jingles  
**All outreach / publishing / posting:** must go through SparkGatekeeper hold queue 🔒  
**Card format:** signed JSON file with hash chain — never a DB row  

**Key files to edit:**
- `dna-foundry/api/src/index.ts` — routes
- `dna-foundry/api/src/services/salesPipeline.ts` — GPS + qualify + close
- `dna-foundry/api/src/services/metering.ts` — credits + billing
- `dna-foundry/api/src/services/contentPipeline.ts` — campaigns + scheduling
- `dna-foundry/api/src/services/aiGateway.ts` — providers + cache
- `dashboard/src/pages/` — all new UI pages
