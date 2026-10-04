"""Build Santino's Pizza v1 card JSON (hand-authored example, not extracted).

DEMONSTRATION CARD — public data only, no affiliation with the business.
Business facts below are the verified public record (2026-10-03):
  Santino's Pizza, 499 Ernston Rd, Parlin, NJ 08859, (732) 721-3163,
  santinospizzanj.com — family owned and operated since 1970.
Prices are unknown and stay null (never invented). Inferred fields are
marked as inferred and never overwrite owner-confirmed data.
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "swarm"))
from canonical import canonical_hash, acting_hash
from datetime import datetime, timezone

now = datetime.now(timezone.utc).isoformat()
SRC = "https://santinospizzanj.com/"

def prov(sources, confidence=0.8, extractor="example:hand-authored"):
    return {"sources": sources, "confidence": confidence,
            "extracted_at": now, "extractor_agent": extractor}

card = {
    "id": "dna_1538e24d",
    "organization_id": "org_pizza0003",
    "version": 1,
    "previous_version": None,
    "status": "draft",
    "created_at": now,
    "identity": {
        "name": "Santino's Pizza",
        "tagline": "Family owned and operated since 1970.",
        "elevator_pitch": "Santino's Pizza is a family owned and operated pizzeria in Parlin, NJ, serving hand-tossed pies since 1970.",
        "mission": "Feed our neighbors like family.",
        "values": ["Family first", "Hand-tossed, never rushed", "Parlin's neighborhood table"],
        "location": "499 Ernston Rd, Parlin, NJ 08859",
        "phone": "(732) 721-3163",
        "website": "https://santinospizzanj.com",
        "timezone": "America/New_York",
    },
    "voice": {
        "tone": ["warm", "familial", "unhurried", "welcoming"],
        "personality": "Like being welcomed into a family pizzeria — unhurried, generous, and glad you came.",
        "donts": ["Never rushed or transactional", "Never pretentious about the food"],
        "lexicon_use": ["family", "hand-tossed", "since 1970"],
        "sample_phrases": ["Mangia! There's plenty.", "Family owned since 1970."],
    },
    "offerings": [
        {"name": "Classic Cheese Pizza", "kind": "menu item",
         "description": "Hand-tossed crust, tomato sauce, mozzarella.",
         "price": None, "orderable": True, "confidence": 0.6},
        {"name": "Pepperoni Pizza", "kind": "menu item",
         "description": "Hand-tossed crust, tomato sauce, mozzarella, pepperoni.",
         "price": None, "orderable": True, "confidence": 0.6},
        {"name": "Chicken Parmigiana", "kind": "menu item",
         "description": "Breaded cutlet, marinara, melted mozzarella.",
         "price": None, "orderable": True, "confidence": 0.6},
        {"name": "Party Trays", "kind": "experience",
         "description": "Large orders and party trays — call ahead so the kitchen can plan.",
         "price": None, "orderable": False, "confidence": 0.6},
    ],
    "operations": {
        "hours": "Call for current hours",
        "channels": ["phone", "in_person"],
        "human_confirm": ["refunds", "allergen questions", "large parties"],
        "notes": "No online ordering yet — call (732) 721-3163.",
    },
    "policies": [
        {"topic": "refunds", "rule": "Handled case by case — please ask for the manager on duty.",
         "source": "owner", "confidence": 0.9},
        {"topic": "allergens", "rule": "Tell us about allergies before ordering; the kitchen will confirm what's safe. Allergen questions hand off to staff, never answered by the agent.",
         "source": "owner", "confidence": 0.9},
    ],
    "handoff": {
        "to_human": ["refunds", "allergen questions", "large parties"],
        "contact": "(732) 721-3163",
    },
    "knowledge": [
        {"ref": SRC, "kind": "other", "title": "Santino's Pizza website", "chunks": 1},
    ],
    "field_provenance": {
        "identity": prov([SRC], 0.7),
        "voice": prov([SRC], 0.6),
        "offerings": prov([SRC], 0.6),
        "operations": prov([SRC], 0.6),
        "policies": prov(["owner:interview"], 0.9),
        "knowledge": prov(["owner:interview"], 0.9),
    },
    # Appendix — inferred, non-quotable
    "strategy": {
        "positioning": "Parlin's neighborhood pizzeria — family owned since 1970, hand-tossed pies without the fuss.",
        "swot": {
            "strengths": ["Family-owned story regulars love", "Serving Parlin since 1970"],
            "weaknesses": ["No online ordering yet", "Menu prices not published"],
            "opportunities": ["Party trays and large orders", "Local event catering"],
            "threats": ["Chain pizzerias on price", "Rising ingredient costs"],
        },
        "key_messaging": ["Hand-tossed since 1970", "You're family here"],
    },
    "customers": {
        "personas": [
            {"name": "Parlin regular", "description": "Local family that orders Friday pizza night.",
             "pain_points": ["Want to order online", "Need large-party trays"], "confidence": 0.4,
             "source": "category:inference — confirm with owner"},
        ],
    },
    "competitors": [
        {"name": "Local independents", "note": "Other family pizzerias in the Parlin area (inferred from category — confirm with owner)",
         "confidence": 0.4, "source": "category:inference"},
    ],
    "insights": [
        {"title": "Since-1970 story is the differentiator", "detail": "Five decades of family ownership is the lead message; few local competitors can match it.",
         "confidence": 0.5, "source": "category:inference"},
    ],
}

card["acting_hash"] = acting_hash(card)
card["hash"] = canonical_hash(card)
out = Path(__file__).parent / "santinos_dna_1538e24d_org_pizza0003_v1.json"
out.write_text(json.dumps(card, indent=2))
print(f"wrote {out} (hash {card['hash'][:16]}...)")
