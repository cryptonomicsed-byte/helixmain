# Santino's Pizza — example card set

DEMONSTRATION CARDS — public data only, no affiliation with the business.

Hand-authored `business-card/0.1` example showing the versioning pattern:

- `santinos_dna_1538e24d_org_pizza0003_v1.json` — v1, hand-authored from
  verified public facts (build with `python3 build_v1.py`).
- `dna_1538e24d_org_pizza0003_v2.json` — v2, sonic-brand voice logo
  (real TTS asset, content-addressed in `foundry/assets/`).
- `dna_1538e24d_org_pizza0003_v3.json` — v3, staged sonic-logo + UI-sound
  briefs (no music-model key; asset refs stay null until generated).

Business facts (verified 2026-10-03): Santino's Pizza, 499 Ernston Rd,
Parlin, NJ 08859, (732) 721-3163, santinospizzanj.com — family owned and
operated since 1970. Prices are unknown and stay `null` (never invented);
inferred appendix fields are marked as inferred.
