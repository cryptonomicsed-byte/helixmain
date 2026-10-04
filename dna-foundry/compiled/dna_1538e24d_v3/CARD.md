---
format: business-card/0.1
id: dna_1538e24d
version: 3
previous_version: 2
previous_hash: sha256:9d7a0f7d8ba07f6508e8324bbcf7ba950e92df959ea0eb947ddc3ac124e2c7b4
hash: sha256:e15c9ed89270c43baba566901cfbfce7ffd0ad36db48fbfe2e7b1a9f26f69364
acting_hash: sha256:9cee3ff17d845f4f752e309023e8013f4efd659d88237cf6f801edbcaa00690e
organization_id: org_pizza0003
status: draft
updated: 2026-10-04T05:38:51.188633+00:00
---

# Santino's Pizza

> Family owned and operated since 1970.

## Identity
- **Name:** Santino's Pizza
- **Pitch:** Santino's Pizza is a family owned and operated pizzeria in Parlin, NJ, serving hand-tossed pies since 1970.
- **Mission:** Feed our neighbors like family.
- **Values:** Family first; Hand-tossed, never rushed; Parlin's neighborhood table
- **Address:** 499 Ernston Rd, Parlin, NJ 08859
- **Phone:** (732) 721-3163
- **Timezone:** America/New_York
- **Source:** https://santinospizzanj.com
- **Phone:** (732) 721-3163
- **Timezone:** America/New_York
- **Source:** https://santinospizzanj.com

## Voice
- **Tone:** warm, familial, unhurried, welcoming
- **Personality:** Like being welcomed into a family pizzeria — unhurried, generous, and glad you came.
- **Samples:** "Mangia! There's plenty." · "Family owned since 1970."
- **Don't:** Never rushed or transactional; Never pretentious about the food
- **Use:** family, hand-tossed, since 1970

## Sound
```yaml
sound:
  logo: {state: staged, brief: "Brand mnemonic for Santino's Pizza (Family owned and operated since 1970.) A 4-second sonic logo in the spirit of the Netflix ta-dum or Intel bong: warm acoustic, warm, welcoming mood, warm, familial, unhurried, welcoming", asset: null, seconds: 4}
  voice_logo: {state: ready, line: "Welcome to Santino's Pizza. Family owned and operated since 1970.", voice: "avocado_v2:MAI_03", asset: "sha256:841512d994b3c6535ace7581a473e1ff90b11b8b7c44b83c4f43d8ad4ad61152"}
  ui:
    notification: {state: staged, brief: "Soft notification chime for Santino's Pizza: warm acoustic, warm, welcoming. A single gentle wooden knock followed by a warm muted tone, under one second, friendly not urgent.", asset: null}
    success: {state: staged, brief: "Success confirm for Santino's Pizza: warm acoustic, warm, welcoming. Two rising notes resolving up, bright but soft, under 1.2 seconds.", asset: null}
    error: {state: staged, brief: "Gentle error nudge for Santino's Pizza: warm acoustic, warm, welcoming. A single low rounded tone, no buzz, no harshness, under one second. Reassuring, not alarming.", asset: null}
```

## Offer
- **Classic Cheese Pizza** · kind: menu item · note: Hand-tossed crust, tomato sauce, mozzarella. · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering {"name":"Classic Cheese Pizza","kind":"menu item","description":"Hand-tossed crust, tomato sauce, mozzarella.","price":null,"orderable":true,"confidence":0.6} -->
- **Pepperoni Pizza** · kind: menu item · note: Hand-tossed crust, tomato sauce, mozzarella, pepperoni. · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering {"name":"Pepperoni Pizza","kind":"menu item","description":"Hand-tossed crust, tomato sauce, mozzarella, pepperoni.","price":null,"orderable":true,"confidence":0.6} -->
- **Chicken Parmigiana** · kind: menu item · note: Breaded cutlet, marinara, melted mozzarella. · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering {"name":"Chicken Parmigiana","kind":"menu item","description":"Breaded cutlet, marinara, melted mozzarella.","price":null,"orderable":true,"confidence":0.6} -->
- **Party Trays** · kind: experience · note: Large orders and party trays — call ahead so the kitchen can plan. · orderable: no · price: null · confidence: 0.6
<!-- machine:offering {"name":"Party Trays","kind":"experience","description":"Large orders and party trays — call ahead so the kitchen can plan.","price":null,"orderable":false,"confidence":0.6} -->

## Operations
- **Hours:** Call for current hours
- **Channels:** phone, in_person
- **Human confirm:** refunds; allergen questions; large parties
- **Notes:** No online ordering yet — call (732) 721-3163.

## Policy
- **refunds:** Handled case by case — please ask for the manager on duty.
<!-- machine:policy {"topic":"refunds","rule":"Handled case by case — please ask for the manager on duty.","source":"owner","confidence":0.9} -->
- **allergens:** Tell us about allergies before ordering; the kitchen will confirm what's safe. Allergen questions hand off to staff, never answered by the agent.
<!-- machine:policy {"topic":"allergens","rule":"Tell us about allergies before ordering; the kitchen will confirm what's safe. Allergen questions hand off to staff, never answered by the agent.","source":"owner","confidence":0.9} -->

## Handoff
- **To human:** refunds; allergen questions; large parties
- **Contact:** (732) 721-3163

## Knowledge
- [Santino's Pizza website](https://santinospizzanj.com/) · other · 1 chunks
<!-- machine:knowledge {"ref":"https://santinospizzanj.com/","kind":"other","title":"Santino's Pizza website","chunks":1} -->

## Provenance
- `identity` — sources: [https://santinospizzanj.com/], confidence 0.7, extractor: example:hand-authored, 2026-10-04T05:38:51.188633+00:00
- `knowledge` — sources: [owner:interview], confidence 0.9, extractor: example:hand-authored, 2026-10-04T05:38:51.188633+00:00
- `offerings` — sources: [https://santinospizzanj.com/], confidence 0.6, extractor: example:hand-authored, 2026-10-04T05:38:51.188633+00:00
- `operations` — sources: [https://santinospizzanj.com/], confidence 0.6, extractor: example:hand-authored, 2026-10-04T05:38:51.188633+00:00
- `policies` — sources: [owner:interview], confidence 0.9, extractor: example:hand-authored, 2026-10-04T05:38:51.188633+00:00
- `voice` — sources: [https://santinospizzanj.com/], confidence 0.6, extractor: example:hand-authored, 2026-10-04T05:38:51.188633+00:00
- `voice.sonic` — sources: [sha256:841512d994b3c6535ace7581a473e1ff90b11b8b7c44b83c4f43d8ad4ad61152], confidence 0.9, extractor: skill:sonic_brand, 2026-10-04T05:39:00.427288+00:00

## Changelog
- **v1** (2026-10-04): hand-authored example — demonstration card: public data only, no affiliation with the business
- **v2** (2026-10-04): sonic-brand voice logo (real TTS asset)
- **v3** (2026-10-04): staged sonic-logo + UI-sound briefs

## Appendix
> Not quotable. For humans and planners only — never speak these in replies.

### Strategy
- **Positioning:** Parlin's neighborhood pizzeria — family owned since 1970, hand-tossed pies without the fuss.
- **Key messaging:** Hand-tossed since 1970; You're family here
- **SWOT:**
  - **Strengths:** Family-owned story regulars love; Serving Parlin since 1970
  - **Weaknesses:** No online ordering yet; Menu prices not published
  - **Opportunities:** Party trays and large orders; Local event catering
  - **Threats:** Chain pizzerias on price; Rising ingredient costs

### Customers
- **Persona: Parlin regular** — Local family that orders Friday pizza night. · pain points: Want to order online; Need large-party trays · confidence: 0.4 · source: category:inference — confirm with owner

### Competitors
- **Local independents** — Other family pizzerias in the Parlin area (inferred from category — confirm with owner)
<!-- machine:competitor {"name":"Local independents","note":"Other family pizzerias in the Parlin area (inferred from category — confirm with owner)","confidence":0.4,"source":"category:inference"} -->

### Insights
- **Since-1970 story is the differentiator** — Five decades of family ownership is the lead message; few local competitors can match it.
<!-- machine:insight {"title":"Since-1970 story is the differentiator","detail":"Five decades of family ownership is the lead message; few local competitors can match it.","confidence":0.5,"source":"category:inference"} -->
