# Crawl cost model — why sense is tiered and adaptive

## The problem

A Business DNA card rots the moment the business changes: new hours, new
menu, a redesign. Keeping 100 cards fresh with a naive "re-crawl everything
daily" loop means paying full extraction price on every site, every day —
including the plumber whose site hasn't changed in two years.

## The design

`sense.py` is a tiered pipeline where expensive work almost never runs, on an
adaptive cadence per site:

| Tier | What runs | When | Unit cost |
|------|-----------|------|-----------|
| 0 — change detection | Conditional HTTP (ETag / If-Modified-Since / HEAD), sitemap.xml lastmod, SHA-256 of HTML vs stored hash. No render, no LLM. | Every cycle | ~$0.0001 |
| 1 — cheap triage | **Jev** (TypeSafe System One) classifies the diff — hours / offering / redesign / new_content / noise — with calibrated confidence; < 0.5 escalates to Tier 2 instead of guessing. Deterministic heuristics are the fallback until early access. | Only on change | ~$0.0001–0.0002 |
| 2 — targeted extraction | Extractor skills run **only** on changed pages/sections → `dna.propose_change` proposals through the Jev-scored policy gate (auto only on confident True; every proposal verified against its evidence, score 0–1). | Only on material change | ~$0.05–0.20 |
| 3 — full re-extract | Whole orchestrator run. | Redesign signals only | ~$0.50 |

**Jev is the decider, the LLM is the writer.** Tier-1 triage, proposal
verification ("is this change supported by the evidence?"), and the
policy gate's auto/allow decision are exactly System One tasks:
unstructured state in, typed probabilistic decisions out, 70–500ms.
Jev's calibrated confidence drives the auto-apply vs escalate threshold —
the property LLMs lack (overconfident, inconsistent). Every Jev call site
has an LLM fallback (cheap model, structured output) and then a
deterministic heuristic, so the pipeline runs today with zero keys; the
`decision_trail` on every proposal and receipt records which provider
decided and why a mutation auto-applied. Tier 2/3 extraction and prompt
compilation stay on the LLM — Jev can't generate strings.

Jev pricing: **$0.042 per million input tokens, output free.** A triage
call carries ~2–4k input tokens → **~$0.0001–0.0002**. A verification call
(~1k tokens) → **~$0.00004**. This is the Jevons paradox working for us:
decisions this cheap mean we can afford to verify *everything* — every
proposal scored against its evidence, every auto-apply gated on calibrated
confidence — instead of rationing judgment calls.

**Adaptive cadence** (the biggest saver): each site carries a volatility
score in the sidecar (`swarm/sense-state/<org>.json`). Start at a 7-day
interval; after 3 consecutive unchanged cycles back off toward 30 days; on
any detected change halve the interval toward 1 day. The scheduler reads the
sidecar's `next_run` — sense never schedules itself.

**Fetch rules:** raw HTML + readability-lite covers ~95% of SMB sites
(WordPress / Squarespace / Wix). A page whose readable text is tiny relative
to its HTML is flagged JS-heavy once and the `js_render` flag is cached;
headless render only ever runs at Tier 2/3 for flagged sites. Paid crawl APIs
(Firecrawl-style per-page pricing) are never in the hot loop — self-hosted
`urllib` fetch only.

## The math — 100-business fleet, per month

### Naive: daily full re-crawl

- 100 sites × 30 days = 3,000 full extractions
- Full extraction ≈ $0.15–0.20 (multi-page fetch + model extraction)
- **≈ $450–600/mo**, and it grows linearly with the fleet. A paid crawl API
  in the loop would roughly double it.

### Tiered + adaptive

Assume a realistic volatility mix:

| Segment | Sites | Cadence after backoff | Tier-0 runs/mo |
|---------|-------|----------------------|----------------|
| Stable (plumber, 2 yrs unchanged) | 60 | ~monthly | 60 |
| Moderate (seasonal menus) | 30 | ~weekly | 120 |
| Volatile (café, weekly specials) | 10 | ~daily | 300 |
| **Tier-0 total** | | | **480** |

Change rates: stable 1/yr, moderate 2/mo, volatile 8/mo →
changes/mo = 60×(1/12) + 30×2 + 10×8 = **145**.

- Tier 0: 480 × $0.0001 = **$0.05**
- Tier 1 triage (Jev): 145 × $0.0002 ≈ **$0.03** — cents, not dollars
- Tier 2 targeted (material ≈ 60% of changes): 87 × $0.10 ≈ **$8.70**
- Tier 3 redesign (rare, ~2%): 3 × $0.50 = **$1.50**
- Jev verification on every proposal: 145 × $0.00004 ≈ **$0.01**
- **Total ≈ $10.30/mo** — single digits, ~50× cheaper than naive.

The dominant term is Tier 2, and it only fires when a site actually changed
*materially*. The plumber costs ~$0.0001/mo. The café costs ~$9/mo. That is
the correct shape: **you pay for volatility, not for the fleet**. And the
decision layer — triage, verification, gating — costs three cents a month
for the whole fleet: calibrated judgment is now cheaper than the HTTP
requests that feed it.

### Sensitivity

- If every site were volatile-daily (worst case), Tier 0 = 3,000 runs
  ($0.30) and Tier 2 ≈ 100 × 8 × 0.6 × $0.10 = $48/mo — still ~10× under naive.
- Halving Tier-2 cost (smaller model, tighter page targeting) roughly halves
  the total; Tier 0/1 are already noise.
- Backoff depth matters more than tier costs: moving stable sites from
  weekly to monthly removes ~180 Tier-0 runs and, more importantly, the
  change-detection surface that feeds the upper tiers.

## What the sidecar holds (per site)

`interval_days`, `consecutive_unchanged`, `volatility` (0–1), `last_run`,
`etag`, `last_modified`, `html_hash`, readability `text` baseline,
`sitemap_lastmod`, `js_render` flag. The card itself stays clean — volatility
is platform bookkeeping, not business content, so it lives beside the card,
not in it.
