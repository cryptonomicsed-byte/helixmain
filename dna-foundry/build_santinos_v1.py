"""Build the Santino's Pizza demo-pipeline v1 card (extraction-style).

DEMONSTRATION CARD — public data only, no affiliation with the business.
Mirrors the structure the swarm extractor mints from the demo fixture site
(dna-foundry/swarm/fixtures/acme-cafe). Prices are unknown and stay null;
inferred appendix fields are marked as inferred.
"""
import json, sys
from datetime import datetime, timezone
from pathlib import Path

FOUNDRY = Path(__file__).resolve().parents[0]
sys.path.insert(0, str(FOUNDRY / "swarm"))
from canonical import canonical_hash, acting_hash

now = datetime.now(timezone.utc).isoformat()
SITE = "file:///tmp/demo-site"

def prov(source, confidence=0.8):
    return {"sources": [source], "confidence": confidence,
            "extracted_at": now, "extractor_agent": "extractor:website"}

card = {
    "id": "dna_c1640d90",
    "organization_id": "org_demo0001",
    "version": 1,
    "previous_version": None,
    "status": "draft",
    "created_at": now,
    "identity": {
        "name": "Santino's Pizza",
        "tagline": "Family owned and operated since 1970. Classic pizza in Parlin, NJ.",
        "location": "499 Ernston Rd, Parlin, NJ 08859",
        "phone": "(732) 721-3163",
        "website": "https://santinospizzanj.com",
        "values": ["family first", "hand-tossed pies", "feed our neighbors like family"],
        "elevator_pitch": "Family owned and operated since 1970 — hand-tossed pies in Parlin, NJ.",
    },
    "voice": {
        "tone": ["warm", "familial", "unhurried", "welcoming"],
        "sample_phrases": [
            "Family owned and operated since 1970",
            "Classic pizza in Parlin, NJ",
            "Our favorites",
            "What our neighbors say",
        ],
        "personality": "Family-run, neighborly pizzeria greeting everyone like a local.",
        "description": "Sounds like a friendly neighbor inviting you in for a Friday pizza night.",
        "donts": [
            "Use cold, corporate or impersonal language.",
            "Brag with aggressive sales hype or pressure.",
            "Rush a caller off the phone.",
        ],
    },
    "offerings": [
        {"name": "Classic Cheese Pizza", "kind": "pizza", "price": None,
         "orderable": True, "confidence": 0.6},
        {"name": "Pepperoni Pizza", "kind": "pizza", "price": None,
         "orderable": True, "confidence": 0.6},
        {"name": "White Pizza", "kind": "pizza", "price": None,
         "orderable": True, "confidence": 0.6},
        {"name": "Chicken Parmigiana", "kind": "entree", "price": None,
         "orderable": True, "confidence": 0.6},
        {"name": "Baked Ziti", "kind": "entree", "price": None,
         "orderable": True, "confidence": 0.6},
        {"name": "Garlic Knots", "kind": "side", "price": None,
         "orderable": True, "confidence": 0.6},
        {"name": "Garden Salad", "kind": "side", "price": None,
         "orderable": True, "confidence": 0.6},
    ],
    "operations": {
        "channels": ["phone"],
        "hours": "Mon\u2013Fri 11am\u20139pm; Sat\u2013Sun 12pm\u20138pm",
    },
    "policies": [
        {"topic": "refunds",
         "rule": "Not happy with your order? Call (732) 721-3163 and ask for the manager on duty \u2014 we\u2019ll make it right."},
        {"topic": "allergens",
         "rule": "Tell us about food allergies before you order. The kitchen will confirm what\u2019s safe. Allergen questions always go to our staff, never to an automated system."},
        {"topic": "large_orders",
         "rule": "Party trays and large orders need advance notice \u2014 call at least a day ahead."},
    ],
    "knowledge": [
        {"ref": f"{SITE}/faq.html", "kind": "faq", "title": "Faq.Html", "chunks": 1},
        {"ref": f"{SITE}/policies.html", "kind": "policy_doc", "title": "Policies.Html", "chunks": 1},
        {"ref": f"{SITE}/index.html", "kind": "review_corpus", "title": "Google reviews summary", "chunks": 1},
    ],
    "insights": [
        {"title": "Recurring review themes",
         "detail": "Google rating 4.1 across 42 reviews \u2014 a Parlin neighborhood staple.",
         "evidence": ["Rated 4.1 stars across 42 Google reviews \u2014 a Parlin neighborhood staple."]},
    ],
    "strategy": {
        "key_messaging": [
            "Family owned and operated since 1970",
            "Classic pizza in Parlin, NJ",
            "Our favorites",
            "Feed our neighbors like family",
        ],
        "positioning": "Family-owned Parlin pizzeria serving hand-tossed pies since 1970.",
        "swot": {
            "strengths": ["Family owned and operated since 1970", "Parlin neighborhood staple"],
            "weaknesses": ["No online ordering yet", "Menu prices not published"],
            "opportunities": [],
            "threats": [],
        },
    },
    "customers": {
        "personas": [
            {"name": "Parlin regular", "role": "Friday pizza night family",
             "pain_points": ["Wants to order online", "Needs large-party trays"],
             "source": "category:inference \u2014 confirm with owner"},
        ],
    },
    "competitors": [
        {"name": "Domino's",
         "positioning": "national pizza chain (inferred from category \u2014 confirm with owner)"},
        {"name": "Pizza Hut",
         "positioning": "national pizza chain (inferred from category \u2014 confirm with owner)"},
        {"name": "Local independents",
         "positioning": "other nearby pizzerias in this category \u2014 ask the owner to name them (inferred from category \u2014 confirm with owner)"},
    ],
    "field_provenance": {
        "identity.name": prov(f"{SITE}/index.html", 0.85),
        "identity.tagline": prov(f"{SITE}/index.html", 0.8),
        "identity.location": prov(f"{SITE}/index.html", 0.85),
        "identity.values": prov(f"{SITE}/about.html", 0.7),
        "identity.elevator_pitch": prov(f"{SITE}/about.html", 0.75),
        "voice.tone": prov(f"{SITE}/index.html", 0.6),
        "voice.sample_phrases": prov(f"{SITE}/index.html", 0.6),
        "voice.personality": prov(f"{SITE}/about.html", 0.6),
        "voice.description": prov(f"{SITE}/about.html", 0.6),
        "voice.donts": prov(f"{SITE}/policies.html", 0.55),
        "offerings": prov(f"{SITE}/menu.html", 0.6),
        "operations.hours": prov(f"{SITE}/index.html", 0.85),
        "operations.channels": prov(f"{SITE}/faq.html", 0.9),
        "policies": prov(f"{SITE}/policies.html", 0.65),
        "knowledge": prov(f"{SITE}/faq.html", 0.7),
        "insights": prov(f"{SITE}/index.html", 0.6),
        "strategy.positioning": prov(f"{SITE}/about.html", 0.6),
        "strategy.key_messaging": prov(f"{SITE}/index.html", 0.6),
        "strategy.swot": prov(f"{SITE}/about.html", 0.55),
        "customers.personas": prov(f"{SITE}/index.html", 0.5),
        "competitors": prov("category:inference", 0.4),
    },
}

card["acting_hash"] = acting_hash(card)
card["hash"] = canonical_hash(card)
out = FOUNDRY / "cards" / "dna_c1640d90_org_demo0001_v1.json"
out.write_text(json.dumps(card, indent=2))
print(f"wrote {out} (hash {card['hash'][:16]}...)")
