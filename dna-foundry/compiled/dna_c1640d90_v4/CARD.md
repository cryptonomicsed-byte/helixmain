---
format: business-card/0.1
id: dna_c1640d90
version: 4
previous_version: 3
previous_hash: sha256:73f747f0430347bc996da8eb6c7c1db4b4cf9c4050cabd76a760ff83b080d581
hash: sha256:3b3801469f8509c67b203ee9dbb0559e4a0501d9084af483147bd23bf18bc17c
acting_hash: sha256:b77b4976dbdc3deb560932d307f1100ba4eaa6ca83a4154681ef0a02b2ff7afc
organization_id: org_demo0001
status: draft
updated: 2026-10-04T05:43:46.741213+00:00
---

# Santino's Pizza

> Family owned and operated since 1970. Classic pizza in Parlin, NJ.

## Identity
- **Name:** Santino's Pizza
<!-- machine:identity_value@1 {"key":"name","text":"Santino's Pizza"} -->
- **Pitch:** Family owned and operated since 1970 — hand-tossed pies in Parlin, NJ.
<!-- machine:identity_value@1 {"key":"elevator_pitch","text":"Family owned and operated since 1970 — hand-tossed pies in Parlin, NJ."} -->
- **Values:** family first; hand-tossed pies; feed our neighbors like family
<!-- machine:identity_value@1 {"key":"values","text":"family first; hand-tossed pies; feed our neighbors like family"} -->
- **Address:** 499 Ernston Rd, Parlin, NJ 08859
<!-- machine:identity_value@1 {"key":"location","text":"499 Ernston Rd, Parlin, NJ 08859"} -->
- **Phone:** (732) 721-3163
<!-- machine:identity_value@1 {"key":"phone","text":"(732) 721-3163"} -->
- **Source:** https://santinospizzanj.com
<!-- machine:identity_value@1 {"key":"website","text":"https://santinospizzanj.com"} -->

## Voice
- **Tone:** warm, familial, unhurried, welcoming
- **Personality:** Family-run, neighborly pizzeria greeting everyone like a local.
- **Description:** Sounds like a friendly neighbor inviting you in for a Friday pizza night.
- **Samples:** "Family owned and operated since 1970" · "Classic pizza in Parlin, NJ" · "Our favorites" · "What our neighbors say"
- **Don't:** Use cold, corporate or impersonal language.
<!-- machine:voice_dont@1 {"text":"Use cold, corporate or impersonal language."} -->
- **Don't:** Brag with aggressive sales hype or pressure.
<!-- machine:voice_dont@1 {"text":"Brag with aggressive sales hype or pressure."} -->
- **Don't:** Rush a caller off the phone.
<!-- machine:voice_dont@1 {"text":"Rush a caller off the phone."} -->

## Sound
```yaml
sound:
  logo: {state: staged}
  voice_logo: {state: ready, line: "Welcome to Santino's Pizza. Family owned and operated since 1970.", voice: "avocado_v2:MAI_03", asset: "sha256:841512d994b3c6535ace7581a473e1ff90b11b8b7c44b83c4f43d8ad4ad61152"}
  ui:
    notification: {state: staged}
    success: {state: staged}
    error: {state: staged}
```

## Offer
- **Classic Cheese Pizza** · kind: pizza · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"Classic Cheese Pizza","kind":"pizza","price":null,"orderable":true,"confidence":0.6} -->
- **Pepperoni Pizza** · kind: pizza · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"Pepperoni Pizza","kind":"pizza","price":null,"orderable":true,"confidence":0.6} -->
- **White Pizza** · kind: pizza · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"White Pizza","kind":"pizza","price":null,"orderable":true,"confidence":0.6} -->
- **Chicken Parmigiana** · kind: entree · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"Chicken Parmigiana","kind":"entree","price":null,"orderable":true,"confidence":0.6} -->
- **Baked Ziti** · kind: entree · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"Baked Ziti","kind":"entree","price":null,"orderable":true,"confidence":0.6} -->
- **Garlic Knots** · kind: side · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"Garlic Knots","kind":"side","price":null,"orderable":true,"confidence":0.6} -->
- **Garden Salad** · kind: side · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering@1 {"name":"Garden Salad","kind":"side","price":null,"orderable":true,"confidence":0.6} -->

## Operations
- **Hours:** Mon–Fri 11am–10pm; Sat–Sun 12pm–8pm
<!-- machine:hour@1 {"text":"Mon–Fri 11am–10pm; Sat–Sun 12pm–8pm"} -->
- **Channel:** phone
<!-- machine:channel@1 {"name":"phone"} -->

## Policy
- **refunds:** Not happy with your order? Call (732) 721-3163 and ask for the manager on duty — we’ll make it right.
<!-- machine:policy@1 {"topic":"refunds","rule":"Not happy with your order? Call (732) 721-3163 and ask for the manager on duty — we’ll make it right."} -->
- **allergens:** Tell us about food allergies before you order. The kitchen will confirm what’s safe. Allergen questions always go to our staff, never to an automated system.
<!-- machine:policy@1 {"topic":"allergens","rule":"Tell us about food allergies before you order. The kitchen will confirm what’s safe. Allergen questions always go to our staff, never to an automated system."} -->
- **large_orders:** Party trays and large orders need advance notice — call at least a day ahead.
<!-- machine:policy@1 {"topic":"large_orders","rule":"Party trays and large orders need advance notice — call at least a day ahead."} -->

## Handoff
> _To be completed with the owner — when the agent hands off to a human, and what happens after hours._

## Knowledge
- [Faq.Html](file:///tmp/demo-site/faq.html) · faq · 1 chunks
<!-- machine:knowledge@1 {"ref":"file:///tmp/demo-site/faq.html","kind":"faq","title":"Faq.Html","chunks":1} -->
- [Policies.Html](file:///tmp/demo-site/policies.html) · policy_doc · 1 chunks
<!-- machine:knowledge@1 {"ref":"file:///tmp/demo-site/policies.html","kind":"policy_doc","title":"Policies.Html","chunks":1} -->
- [Google reviews summary](file:///tmp/demo-site/index.html) · review_corpus · 1 chunks
<!-- machine:knowledge@1 {"ref":"file:///tmp/demo-site/index.html","kind":"review_corpus","title":"Google reviews summary","chunks":1} -->

## Provenance
- `competitors` — sources: [category:inference], confidence 0.4, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `customers.personas` — sources: [file:///tmp/demo-site/index.html], confidence 0.5, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `identity.elevator_pitch` — sources: [file:///tmp/demo-site/about.html], confidence 0.75, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `identity.location` — sources: [file:///tmp/demo-site/index.html], confidence 0.85, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `identity.name` — sources: [file:///tmp/demo-site/index.html], confidence 0.85, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `identity.tagline` — sources: [file:///tmp/demo-site/index.html], confidence 0.8, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `identity.values` — sources: [file:///tmp/demo-site/about.html], confidence 0.7, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `insights` — sources: [operator marking per Phase 2 demo requirements], confidence 0.7, extractor: mutator:dna.propose_change, 2026-10-04T05:43:46.741220+00:00
- `knowledge` — sources: [file:///tmp/demo-site/faq.html], confidence 0.7, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `offerings` — sources: [file:///tmp/demo-site/menu.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `operations.channels` — sources: [file:///tmp/demo-site/faq.html], confidence 0.9, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `operations.hours` — sources: [sense:tier2 (file:///tmp/demo-site/index.html)], confidence 0.7, extractor: mutator:dna.propose_change, 2026-10-04T05:39:40.829598+00:00
- `policies` — sources: [file:///tmp/demo-site/policies.html], confidence 0.65, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `strategy.key_messaging` — sources: [file:///tmp/demo-site/index.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `strategy.positioning` — sources: [file:///tmp/demo-site/about.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `strategy.swot` — sources: [file:///tmp/demo-site/about.html], confidence 0.55, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `voice.description` — sources: [file:///tmp/demo-site/about.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `voice.donts` — sources: [file:///tmp/demo-site/policies.html], confidence 0.55, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `voice.personality` — sources: [file:///tmp/demo-site/about.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `voice.sample_phrases` — sources: [file:///tmp/demo-site/index.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00
- `voice.sonic` — sources: [sha256:841512d994b3c6535ace7581a473e1ff90b11b8b7c44b83c4f43d8ad4ad61152], confidence 0.9, extractor: skill:sonic_brand, 2026-10-04T05:39:35.694510+00:00
- `voice.tone` — sources: [file:///tmp/demo-site/index.html], confidence 0.6, extractor: extractor:website, 2026-10-04T05:39:28.079367+00:00

## Changelog

## Appendix
> Not quotable. For humans and planners only — never speak these in replies.

### Strategy
- **Positioning:** Family-owned Parlin pizzeria serving hand-tossed pies since 1970.
- **Key messaging:** Family owned and operated since 1970; Classic pizza in Parlin, NJ; Our favorites; Feed our neighbors like family
- **SWOT:**
  - **Strengths:** Family owned and operated since 1970; Parlin neighborhood staple
  - **Weaknesses:** No online ordering yet; Menu prices not published

### Customers
- **Persona: Parlin regular** — role: Friday pizza night family · pain points: Wants to order online; Needs large-party trays · source: category:inference — confirm with owner

### Competitors
- **Domino's** — national pizza chain (inferred from category — confirm with owner)
<!-- machine:competitor {"name":"Domino's","positioning":"national pizza chain (inferred from category — confirm with owner)"} -->
- **Pizza Hut** — national pizza chain (inferred from category — confirm with owner)
<!-- machine:competitor {"name":"Pizza Hut","positioning":"national pizza chain (inferred from category — confirm with owner)"} -->
- **Local independents** — other nearby pizzerias in this category — ask the owner to name them (inferred from category — confirm with owner)
<!-- machine:competitor {"name":"Local independents","positioning":"other nearby pizzerias in this category — ask the owner to name them (inferred from category — confirm with owner)"} -->

### Insights
- **Recurring review themes** — Google rating 4.1 across 42 reviews — a Parlin neighborhood staple. (evidence: Rated 4.1 stars across 42 Google reviews — a Parlin neighborhood staple.)
<!-- machine:insight {"title":"Recurring review themes","detail":"Google rating 4.1 across 42 reviews — a Parlin neighborhood staple.","evidence":["Rated 4.1 stars across 42 Google reviews — a Parlin neighborhood staple."]} -->
- **Demonstration marking** — Demonstration card built from public data only (santinospizzanj.com, Google listing). No affiliation with Santino’s Pizza; not owner-confirmed. For HelixMain Phase 2 compiler-spike testing. (evidence: operator marking per Phase 2 demo requirements)
<!-- machine:insight {"title":"Demonstration marking","detail":"Demonstration card built from public data only (santinospizzanj.com, Google listing). No affiliation with Santino’s Pizza; not owner-confirmed. For HelixMain Phase 2 compiler-spike testing.","evidence":["operator marking per Phase 2 demo requirements"]} -->
