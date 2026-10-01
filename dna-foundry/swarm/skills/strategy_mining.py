"""Skill: strategy_mining — heuristic strategist.

Without an LLM key this mines the strategist's fields from evidence:
  - key_messaging: most repeated h1/h2 phrases across pages (top 3)
  - elevator_pitch: meta description, else first about paragraph (<= 25 words)
  - positioning: one line composed from tagline + differentiator signals
  - personas: audience language -> personas; FAQ questions ARE pain points
  - swot: strengths from evidence-backed claims (years, locations, awards,
    certifications); opportunities from expansion signals (wholesale,
    subscriptions, new locations, classes); weaknesses/threats ONLY when the
    site states them — never invented.

With HELIX_MODEL_GATEWAY_URL the strategy agent upgrades these via the
per-agent strategist prompt (swarm/llm_extract.py); heuristics are the floor.
"""
import re
from collections import Counter

from agents.base import Finding
from skills._util import headings, meta_content, visible_text

SKILL = {
    "name": "strategy_mining",
    "version": "1.0.0",
    "description": "Mine positioning, messaging, personas, and evidence-backed SWOT.",
    "fields": ["strategy.positioning", "strategy.key_messaging", "strategy.swot",
               "customers.personas", "identity.elevator_pitch"],
}

_STRENGTH_SIGNALS = [
    (r"since\s+(19|20)\d{2}", "heritage", 0.7),
    (r"award[\-\s]?winning", "award-winning", 0.65),
    (r"direct trade|direct-trade", "direct trade sourcing", 0.65),
    (r"\borganic\b", "organic", 0.6),
    (r"certified\s+\w+", "certified", 0.6),
    (r"roasted\s+(in-house|onsite|on-site|locally)", "in-house roasting", 0.65),
    (r"sustainab", "sustainability focus", 0.55),
]

_OPPORTUNITY_SIGNALS = [
    (r"wholesale", "wholesale program signals B2B expansion", 0.7),
    (r"subscri", "subscription offering signals recurring revenue", 0.7),
    (r"new location|coming soon|now open", "location expansion in progress", 0.75),
    (r"class|workshop|brewing guide", "education content signals community building", 0.6),
    (r"catering|events", "events/catering signals new revenue line", 0.6),
]

_WEAKNESS_SIGNALS = [
    (r"we don'?t (ship|deliver)[^.]{0,80}", None, 0.7),
    (r"currently (closed|unavailable)[^.]{0,60}", None, 0.7),
    (r"limited (seating|hours|availability)[^.]{0,60}", None, 0.65),
]

_AUDIENCE_SIGNALS = [
    (r"wholesale|caf[eé]s and restaurants|partners", "Café & restaurant partners", "B2B buyer"),
    (r"subscri|home brew|brew at home", "Home brewers", "Consumer"),
    (r"class|learn to brew|barista training", "Aspiring baristas", "Learner"),
    (r"gift", "Gift buyers", "Consumer"),
]


def _first_sentences(text: str, max_words: int = 25) -> str | None:
    sents = re.split(r"(?<=[.!?])\s+", text.strip())
    for s in sents:
        w = s.split()
        if 8 <= len(w) <= 40:
            return " ".join(w[:max_words])
    return None


def run(ctx):
    pages: dict[str, str] = ctx.get("pages", {})
    if not pages and ctx.get("html"):
        pages = {ctx.get("url", ""): ctx["html"]}
    if not pages:
        return []
    out = []
    home_url = ctx.get("home_url") or next(iter(pages))
    home_html = pages.get(home_url) or next(iter(pages.values()))

    # --- key messaging: most repeated h1/h2 across pages ---
    hcounts: Counter = Counter()
    for url, html in pages.items():
        for h in headings(html, 1) + headings(html, 2):
            if 4 < len(h) < 90:
                hcounts[h] += 1
    repeated = [h for h, c in hcounts.most_common(6) if c >= 2]
    if not repeated:
        repeated = [h for h, _ in hcounts.most_common(3)]
    if repeated:
        out.append(Finding("strategy.key_messaging", repeated[:3], 0.6, list(pages)))

    # --- elevator pitch ---
    pitch = meta_content(home_html, "og:description", "description")
    if not (pitch and 20 < len(pitch) < 220):
        for url, html in pages.items():
            if re.search(r"about|story", url, re.I):
                t = visible_text(html)
                pitch = _first_sentences(t)
                if pitch:
                    break
    if pitch:
        out.append(Finding("identity.elevator_pitch", pitch.strip(), 0.65, [home_url]))

    # --- positioning: tagline + differentiator ---
    tagline = None
    for f in out:
        pass
    diffs = []
    blob = " ".join(visible_text(h) for h in pages.values()).lower()
    for pat, label, _ in _STRENGTH_SIGNALS:
        if re.search(pat, blob):
            diffs.append(label)
    name_guess = ctx.get("business_name") or "This business"
    if diffs:
        pos = f"{name_guess}: " + ", ".join(diffs[:3]) + "."
        out.append(Finding("strategy.positioning", pos[:160], 0.55, list(pages)))

    # --- swot ---
    swot: dict[str, list[str]] = {}
    strengths = []
    for pat, label, conf in _STRENGTH_SIGNALS:
        m = re.search(pat, blob)
        if m:
            strengths.append(f"{label} ({m.group(0)[:40].strip()})")
    loc_count = len(re.findall(r"location|los angeles|san francisco|café \d", blob))
    if strengths:
        swot["strengths"] = strengths[:4]
    opportunities = [label for pat, label, _ in _OPPORTUNITY_SIGNALS if re.search(pat, blob)]
    if opportunities:
        swot["opportunities"] = opportunities[:4]
    weaknesses = []
    for pat, _, _ in _WEAKNESS_SIGNALS:
        m = re.search(pat, blob)
        if m:
            weaknesses.append(m.group(0)[:80].strip())
    if weaknesses:
        swot["weaknesses"] = weaknesses[:2]
    # threats: only from explicit statements; otherwise honestly absent
    if swot:
        out.append(Finding("strategy.swot", swot, 0.55, list(pages)))

    # --- personas: audience signals + FAQ-mined pain points ---
    pain_points: list[str] = []
    for url, html in pages.items():
        if re.search(r"faq", url, re.I):
            for q in re.findall(r"<(?:h[234]|summary|strong)[^>]*>([^<]{8,120}\?)", html):
                pain_points.append(q.strip())
    pain_points = pain_points[:6]
    personas = []
    for pat, pname, role in _AUDIENCE_SIGNALS:
        if re.search(pat, blob):
            p: dict = {"name": pname, "role": role}
            if pain_points:
                p["pain_points"] = pain_points[:3]
            personas.append(p)
    if personas:
        out.append(Finding("customers.personas", personas[:3], 0.55, list(pages)))
    elif pain_points:
        out.append(Finding("customers.personas", [{
            "name": "Curious customers", "role": "Consumer",
            "pain_points": pain_points[:3]}], 0.5, list(pages)))
    return out


SKILL["run"] = run
