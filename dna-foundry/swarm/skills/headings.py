"""Skill: headings — offerings and positioning from heading structure."""
from agents.base import Finding
from skills._util import headings, looks_like_noise

SKILL = {
    "name": "headings",
    "version": "1.0.0",
    "description": "Derive offerings and fallback tagline from h1/h2 structure.",
    "fields": ["offerings", "identity.tagline"],
}

_NOISE = {"home", "welcome", "menu", "about", "contact", "services", "products",
          "visit us", "visit", "our favorites", "favorites", "what our neighbors say",
          "testimonials", "reviews", "hours", "location", "find us"}


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    out = []
    h1s = headings(html, 1)
    if h1s and not ctx.get("has_tagline"):
        out.append(Finding("identity.tagline", h1s[0], 0.6, [url]))
    seen = set()
    for h in headings(html, 2):
        h = h.strip()
        if len(h) < 4 or h.lower() in _NOISE or h.lower() in seen:
            continue
        if looks_like_noise(h):
            continue  # section headings ("Family owned and operated since 1970.") aren't offerings
        seen.add(h.lower())
        out.append(Finding("offerings", {"name": h}, 0.55, [url]))
        if len(seen) >= 8:
            break
    return out


SKILL["run"] = run
