"""Skill: competitor_inference — obvious category competitors when the site names none.

Justin's rule: an empty competitor list is a product gap, not honesty. When
on-site evidence yields nothing, fall back to the obvious surrounding
companies for the business category (national chains) plus a stub for the
local independents the owner names.

Honesty mechanism: every inferred competitor carries
  positioning: "... (inferred from category — confirm with owner)",
confidence 0.4, source "category:inference". The card never presents these
as the business's own claims; the owner confirms or replaces them.

ctx: {"card": dict} — category is detected from identity/offerings/strategy text.
Emits one Finding("competitors", {...}) per inferred competitor.
"""
from __future__ import annotations

import re

try:
    from agents.base import Finding
except ImportError:  # skill loaded without swarm on path (docs/tests)
    Finding = None  # type: ignore

# category keyword -> [(chain name, positioning)]
CHAINS: dict[str, list[tuple[str, str]]] = {
    "coffee": [("Starbucks", "national coffee chain"),
               ("Dunkin'", "national coffee-and-donut chain")],
    "donut": [("Dunkin'", "national donut chain"),
              ("Krispy Kreme", "national donut chain")],
    "pizza": [("Domino's", "national pizza chain"),
              ("Pizza Hut", "national pizza chain")],
    "burger": [("McDonald's", "national burger chain"),
               ("Burger King", "national burger chain"),
               ("Wendy's", "national burger chain")],
    "sandwich": [("Subway", "national sandwich chain")],
    "deli": [("Subway", "national sandwich chain")],
    "bakery": [("Panera Bread", "national bakery-cafe chain")],
    "ice cream": [("Baskin-Robbins", "national ice cream chain"),
                  ("Dairy Queen", "national ice cream chain")],
    "gelato": [("Baskin-Robbins", "national ice cream chain")],
    "taco": [("Taco Bell", "national taco chain"),
             ("Chipotle", "national fast-casual Mexican chain")],
    "mexican": [("Taco Bell", "national taco chain"),
                ("Chipotle", "national fast-casual Mexican chain")],
    "burrito": [("Chipotle", "national fast-casual Mexican chain")],
    "chicken": [("Chick-fil-A", "national chicken chain"),
                ("KFC", "national chicken chain"),
                ("Popeyes", "national chicken chain")],
    "wings": [("Buffalo Wild Wings", "national wings chain")],
    "chinese": [("Panda Express", "national Chinese fast-food chain")],
    "salon": [("Great Clips", "national hair-salon chain"),
              ("Supercuts", "national hair-salon chain")],
    "barber": [("Great Clips", "national hair-salon chain")],
    "hair": [("Great Clips", "national hair-salon chain"),
             ("Supercuts", "national hair-salon chain")],
    "gym": [("Planet Fitness", "national gym chain"),
            ("Anytime Fitness", "national gym chain")],
    "fitness": [("Planet Fitness", "national gym chain"),
                ("Anytime Fitness", "national gym chain")],
    "yoga": [("CorePower Yoga", "national yoga studio chain")],
    "auto repair": [("Jiffy Lube", "national auto-service chain"),
                    ("Firestone", "national auto-service chain")],
    "oil change": [("Jiffy Lube", "national quick-lube chain")],
    "florist": [("1-800-Flowers", "national flower delivery")],
    "flowers": [("1-800-Flowers", "national flower delivery")],
    "pet": [("PetSmart", "national pet retailer"),
            ("Petco", "national pet retailer")],
    "real estate": [("RE/MAX", "national real-estate brokerage"),
                    ("Keller Williams", "national real-estate brokerage")],
    "insurance": [("State Farm", "national insurer"),
                  ("GEICO", "national insurer")],
    "pharmacy": [("CVS", "national pharmacy chain"),
                 ("Walgreens", "national pharmacy chain")],
}

SUFFIX = "(inferred from category — confirm with owner)"

SKILL = {
    "name": "competitor_inference",
    "version": "1.0.0",
    "description": "Infer obvious category competitors (national chains + local stub) when the site names none. All findings are marked inferred, confidence 0.4.",
    "fields": ["competitors"],
}


def _category_blob(card: dict) -> str:
    ident = card.get("identity") or {}
    strat = card.get("strategy") or {}
    parts = [
        ident.get("name", ""), ident.get("tagline", ""),
        ident.get("elevator_pitch", ""), strat.get("positioning", ""),
    ]
    for o in card.get("offerings") or []:
        if isinstance(o, dict) and o.get("name"):
            parts.append(o["name"])
    return " ".join(parts).lower()


def infer(card: dict) -> list[dict]:
    blob = _category_blob(card)
    seen: dict[str, dict] = {}
    for keyword, chains in CHAINS.items():
        if re.search(r"\b" + re.escape(keyword) + r"s?\b", blob):
            for name, pos in chains:
                if name.lower() not in seen and len(seen) < 6:
                    seen[name.lower()] = {
                        "name": name,
                        "positioning": f"{pos} {SUFFIX}",
                    }
    out = list(seen.values())
    out.append({
        "name": "Local independents",
        "positioning": ("other nearby shops in this category — "
                        "ask the owner to name them " + SUFFIX),
    })
    return out


def run(ctx):
    if Finding is None:
        raise RuntimeError("swarm/ must be on sys.path to run the competitor_inference skill")
    card = ctx.get("card", {})
    out = []
    for comp in infer(card):
        f = Finding("competitors", comp, 0.4, ["category:inference"])
        f.extractor_agent = "skill:competitor_inference"
        out.append(f)
    return out


SKILL["run"] = run
