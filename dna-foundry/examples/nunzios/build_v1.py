"""Build Nunzio's Kitchen v1 card JSON (hand-authored example, not extracted)."""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "swarm"))
from canonical import canonical_hash
from datetime import datetime, timezone

now = datetime.now(timezone.utc).isoformat()
SRC = "https://nunzioskitchen.com/"

def prov(sources, confidence=0.8, extractor="example:hand-authored"):
    return {"sources": sources, "confidence": confidence,
            "extracted_at": now, "extractor_agent": extractor}

card = {
    "id": "dna_2e76ab2c",
    "organization_id": "org_pizza0003",
    "version": 1,
    "previous_version": None,
    "status": "draft",
    "created_at": now,
    "identity": {
        "name": "Nunzio's Kitchen",
        "tagline": "A family table, set for Sayreville.",
        "elevator_pitch": "Nunzio's Kitchen is a family-run Italian kitchen in Sayreville, NJ, serving handmade classics at a table that feels like home.",
        "mission": "Feed our neighbors like family.",
        "values": ["Family first", "Handmade, never rushed", "Neighbors are regulars"],
        "location": "521 Raritan St, Sayreville, NJ 08872",
        "phone": "(732) 727-1060",
        "email": "hello@nunzioskitchen.com",
        "timezone": "America/New_York",
    },
    "voice": {
        "tone": ["warm", "familial", "handmade", "welcoming"],
        "personality": "Like being welcomed into an Italian family's dining room — unhurried, generous, and glad you came.",
        "donts": ["Never rushed or transactional", "Never pretentious about the food"],
        "lexicon_use": ["family", "homemade", "from our kitchen"],
        "sample_phrases": ["Mangia! There's plenty.", "You're family here."],
    },
    "offerings": [
        {"name": "Margherita Pizza", "kind": "menu item",
         "description": "Hand-stretched crust, San Marzano tomato, fresh mozzarella, basil.",
         "price": None, "orderable": True, "confidence": 0.6},
        {"name": "Chicken Parmigiana", "kind": "menu item",
         "description": "Breaded cutlet, marinara, melted mozzarella, side of pasta.",
         "price": None, "orderable": True, "confidence": 0.6},
        {"name": "Sunday Family Dinner", "kind": "experience",
         "description": "Weekly Sunday table — bring the whole family. Call ahead for large parties.",
         "price": None, "orderable": False, "confidence": 0.6},
    ],
    "operations": {
        "hours": "Call for current hours",
        "channels": ["phone", "in_person"],
        "human_confirm": ["refunds", "allergen questions", "large parties"],
        "notes": "BYOB. No online ordering yet — call (732) 727-1060.",
    },
    "policies": [
        {"topic": "refunds", "rule": "Handled case by case — please ask for the manager on duty.",
         "source": "owner", "confidence": 0.9},
        {"topic": "allergens", "rule": "Tell us about allergies before ordering; the kitchen will confirm what's safe. Allergen questions hand off to staff, never answered by the agent.",
         "source": "owner", "confidence": 0.9},
    ],
    "handoff": {
        "to_human": ["refunds", "allergen questions", "catering inquiries"],
        "contact": "(732) 727-1060",
    },
    "knowledge": [
        {"ref": SRC, "kind": "other", "title": "Nunzio's Kitchen website", "chunks": 1},
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
        "positioning": "The neighborhood's family table — handmade Italian without the white-tablecloth markup.",
        "swot": {
            "strengths": ["Family-run story regulars love", "Handmade dough and sauces"],
            "weaknesses": ["No online ordering yet", "Limited delivery radius"],
            "opportunities": ["Sunday family dinner tradition", "Local event catering"],
            "threats": ["Chain pizzerias on price", "Rising ingredient costs"],
        },
        "key_messaging": ["Handmade like nonna's", "You're family here"],
    },
    "customers": {
        "personas": [
            {"name": "Sayreville regular", "description": "Local family that orders Friday pizza night.",
             "pain_points": ["Want to order online", "Need large-party seating"], "confidence": 0.4,
             "source": "category:inference — confirm with owner"},
        ],
    },
    "competitors": [
        {"name": "Local independents", "note": "Other family pizzerias in the Sayreville area (inferred from category — confirm with owner)",
         "confidence": 0.4, "source": "category:inference"},
    ],
    "insights": [
        {"title": "BYOB is a differentiator", "detail": "Few local Italian spots are BYOB; lead with it in messaging.",
         "confidence": 0.5, "source": "category:inference"},
    ],
}

card["hash"] = canonical_hash(card)
out = Path(__file__).parent / "nunzios_dna_2e76ab2c_org_pizza0003_v1.json"
out.write_text(json.dumps(card, indent=2))
print(f"wrote {out} (hash {card['hash'][:16]}...)")
