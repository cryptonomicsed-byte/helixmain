"""Skill: testimonials — review themes from on-site testimonial sections."""
import re
from collections import Counter
from agents.base import Finding
from skills._util import visible_text

SKILL = {
    "name": "testimonials",
    "version": "1.0.0",
    "description": "Mine testimonial/review sections for customer-sentiment themes.",
    "fields": ["insights", "knowledge"],
}

_THEMES = {
    "service": ["service", "staff", "friendly", "helpful", "welcoming"],
    "quality": ["quality", "delicious", "fresh", "amazing", "best", "great"],
    "atmosphere": ["atmosphere", "cozy", "ambiance", "decor", "vibe", "comfortable"],
    "value": ["price", "value", "affordable", "worth", "deal"],
    "speed": ["fast", "quick", "prompt", "wait", "slow"],
}


def run(ctx):
    pages = ctx.get("pages", {ctx.get("url", ""): ctx.get("html", "")})
    quotes = []
    for url, html in pages.items():
        if not re.search(r"testimonial|review", url + html[:2000], re.I):
            continue
        for m in re.finditer(r"<blockquote[^>]*>(.*?)</blockquote>", html, re.I | re.S):
            q = visible_text(m.group(1))
            if len(q) > 30:
                quotes.append((q, url))
    if not quotes:
        return []
    corpus = " ".join(q for q, _ in quotes).lower()
    words = re.findall(r"[a-z']+", corpus)
    counts = Counter(words)
    themes = []
    for theme, lex in _THEMES.items():
        hits = sum(counts.get(w, 0) for w in lex)
        if hits:
            themes.append((theme, hits))
    themes.sort(key=lambda x: -x[1])
    out = []
    if themes:
        top = ", ".join(t for t, _ in themes[:3])
        out.append(Finding("insights", {
            "title": "Recurring review themes",
            "detail": f"On-site testimonials emphasize: {top}.",
            "evidence": [q[:160] for q, _ in quotes[:3]],
        }, 0.55, [u for _, u in quotes[:3]]))
    out.append(Finding("knowledge", {
        "ref": quotes[0][1], "kind": "review_corpus",
        "title": "On-site testimonials", "chunks": max(1, len(corpus) // 2000),
    }, 0.7, [quotes[0][1]]))
    return out


SKILL["run"] = run
