---
format: business-card/0.1
id: dna_2e76ab2c
version: 3
previous_version: 2
previous_hash: sha256:01da339a33ced8fef97403031734b8a189adb6fd93a335d8010dfb31a44696b7
hash: sha256:c82471cf5f8b910843dc28c18589a7a1ae648689248c0a3894025b5e7235ac71
acting_hash: sha256:1deb9fa423c6230926ed5d97f7f6d646ac83011b84b27b7879dd7d5cc8b992ed
organization_id: org_pizza0003
status: draft
updated: 2026-10-01T09:09:20.691352+00:00
---

# Nunzio's Kitchen

> A family table, set for Sayreville.

## Identity
- **Name:** Nunzio's Kitchen
- **Pitch:** Nunzio's Kitchen is a family-run Italian kitchen in Sayreville, NJ, serving handmade classics at a table that feels like home.
- **Mission:** Feed our neighbors like family.
- **Values:** Family first; Handmade, never rushed; Neighbors are regulars
- **Address:** 521 Raritan St, Sayreville, NJ 08872
- **Phone:** (732) 727-1060
- **Email:** hello@nunzioskitchen.com
- **Timezone:** America/New_York
- **Phone:** (732) 727-1060
- **Email:** hello@nunzioskitchen.com
- **Timezone:** America/New_York

## Voice
- **Tone:** warm, familial, handmade, welcoming
- **Personality:** Like being welcomed into an Italian family's dining room — unhurried, generous, and glad you came.
- **Samples:** "Mangia! There's plenty." · "You're family here."
- **Don't:** Never rushed or transactional; Never pretentious about the food
- **Use:** family, homemade, from our kitchen

## Sound
```yaml
sound:
  logo: {state: staged, brief: "Brand mnemonic for Nunzio's Kitchen (A family table, set for Sayreville.). A 4-second sonic logo in the spirit of the Netflix ta-dum or Intel bong: warm acoustic, warm, welcoming mood, warm, familial, handmade, welcoming", asset: null, seconds: 4}
  voice_logo: {state: ready, line: "Welcome to Nunzio's Kitchen. A family table, set for Sayreville.", voice: "avocado_v2:MAI_03", asset: "sha256:feaaf23d56ef73c7ca6391ffd6ccbe8fe5b2b29d807ad05722b6bdb45a757e58"}
  ui:
    notification: {state: staged, brief: "Soft notification chime for Nunzio's Kitchen: warm acoustic, warm, welcoming. A single gentle wooden knock followed by a warm muted tone, under one second, frie", asset: null}
    success: {state: staged, brief: "Success confirm for Nunzio's Kitchen: warm acoustic, warm, welcoming. Two rising notes resolving up, bright but soft, under 1.2 seconds.", asset: null}
    error: {state: staged, brief: "Gentle error nudge for Nunzio's Kitchen: warm acoustic, warm, welcoming. A single low rounded tone, no buzz, no harshness, under one second. Reassuring, not ala", asset: null}
```

## Offer
- **Margherita Pizza** · kind: menu item · note: Hand-stretched crust, San Marzano tomato, fresh mozzarella, basil. · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering {"name":"Margherita Pizza","kind":"menu item","description":"Hand-stretched crust, San Marzano tomato, fresh mozzarella, basil.","price":null,"orderable":true,"confidence":0.6} -->
- **Chicken Parmigiana** · kind: menu item · note: Breaded cutlet, marinara, melted mozzarella, side of pasta. · orderable: yes · price: null · confidence: 0.6
<!-- machine:offering {"name":"Chicken Parmigiana","kind":"menu item","description":"Breaded cutlet, marinara, melted mozzarella, side of pasta.","price":null,"orderable":true,"confidence":0.6} -->
- **Sunday Family Dinner** · kind: experience · note: Weekly Sunday table — bring the whole family. Call ahead for large parties. · orderable: no · price: null · confidence: 0.6
<!-- machine:offering {"name":"Sunday Family Dinner","kind":"experience","description":"Weekly Sunday table — bring the whole family. Call ahead for large parties.","price":null,"orderable":false,"confidence":0.6} -->

## Operations
- **Hours:** Call for current hours
- **Channels:** phone, in_person
- **Human confirm:** refunds; allergen questions; large parties
- **Notes:** BYOB. No online ordering yet — call (732) 727-1060.

## Policy
- **refunds:** Handled case by case — please ask for the manager on duty.
<!-- machine:policy {"topic":"refunds","rule":"Handled case by case — please ask for the manager on duty.","source":"owner","confidence":0.9} -->
- **allergens:** Tell us about allergies before ordering; the kitchen will confirm what's safe. Allergen questions hand off to staff, never answered by the agent.
<!-- machine:policy {"topic":"allergens","rule":"Tell us about allergies before ordering; the kitchen will confirm what's safe. Allergen questions hand off to staff, never answered by the agent.","source":"owner","confidence":0.9} -->

## Handoff
- **To human:** refunds; allergen questions; catering inquiries
- **Contact:** (732) 727-1060

## Knowledge
- [Nunzio's Kitchen website](https://nunzioskitchen.com/) · other · 1 chunks
<!-- machine:knowledge {"ref":"https://nunzioskitchen.com/","kind":"other","title":"Nunzio's Kitchen website","chunks":1} -->

## Provenance
- `identity` — sources: [https://nunzioskitchen.com/], confidence 0.7, extractor: example:hand-authored, 2026-10-01T09:09:20.691352+00:00
- `knowledge` — sources: [owner:interview], confidence 0.9, extractor: example:hand-authored, 2026-10-01T09:09:20.691352+00:00
- `offerings` — sources: [https://nunzioskitchen.com/], confidence 0.6, extractor: example:hand-authored, 2026-10-01T09:09:20.691352+00:00
- `operations` — sources: [https://nunzioskitchen.com/], confidence 0.6, extractor: example:hand-authored, 2026-10-01T09:09:20.691352+00:00
- `policies` — sources: [owner:interview], confidence 0.9, extractor: example:hand-authored, 2026-10-01T09:09:20.691352+00:00
- `voice` — sources: [https://nunzioskitchen.com/], confidence 0.6, extractor: example:hand-authored, 2026-10-01T09:09:20.691352+00:00
- `voice.sonic` — sources: [sha256:feaaf23d56ef73c7ca6391ffd6ccbe8fe5b2b29d807ad05722b6bdb45a757e58], confidence 0.9, extractor: skill:sonic_brand, 2026-10-01T09:10:46.658400+00:00

## Changelog

## Appendix
> Not quotable. For humans and planners only — never speak these in replies.

### Strategy
- **Positioning:** The neighborhood's family table — handmade Italian without the white-tablecloth markup.
- **Key messaging:** Handmade like nonna's; You're family here
- **SWOT:**
  - **Strengths:** Family-run story regulars love; Handmade dough and sauces
  - **Weaknesses:** No online ordering yet; Limited delivery radius
  - **Opportunities:** Sunday family dinner tradition; Local event catering
  - **Threats:** Chain pizzerias on price; Rising ingredient costs

### Customers
- **Persona: Sayreville regular** — Local family that orders Friday pizza night. · pain points: Want to order online; Need large-party seating · confidence: 0.4 · source: category:inference — confirm with owner

### Competitors
- **Local independents** — Other family pizzerias in the Sayreville area (inferred from category — confirm with owner)
<!-- machine:competitor {"name":"Local independents","note":"Other family pizzerias in the Sayreville area (inferred from category — confirm with owner)","confidence":0.4,"source":"category:inference"} -->

### Insights
- **BYOB is a differentiator** — Few local Italian spots are BYOB; lead with it in messaging.
<!-- machine:insight {"title":"BYOB is a differentiator","detail":"Few local Italian spots are BYOB; lead with it in messaging.","confidence":0.5,"source":"category:inference"} -->
