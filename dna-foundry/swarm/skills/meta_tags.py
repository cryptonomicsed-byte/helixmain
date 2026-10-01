"""Skill: meta_tags — brand identity from <meta>/<title> tags."""
import html as _html
import re

from agents.base import Finding
from skills._util import meta_content, title_tag

SKILL = {
    "name": "meta_tags",
    "version": "1.1.0",
    "description": "Extract business name and tagline from meta tags and title.",
    "fields": ["identity.name", "identity.tagline"],
}

# Words that, on their own, describe a category rather than a business.
_GENERIC_WORDS = {
    "coffee", "roastery", "roasters", "cafe", "café", "restaurant", "pizzeria",
    "pizza", "bakery", "salon", "barbershop", "barber", "shop", "store", "home",
    "homepage", "welcome", "best", "top", "official", "site", "website",
}


def _is_generic(segment: str) -> bool:
    words = [w for w in re.sub(r"[^a-z ]", "", segment.lower()).split() if w]
    return bool(words) and all(w in _GENERIC_WORDS for w in words)


def brand_name_from_title(title: str) -> str:
    """Pick the business-name segment out of a compound title.

    Titles come in two orders: "Site Name - Page" and "Page - Site Name".
    The business name is the segment that isn't a generic category phrase;
    when the first segment is generic ("Coffee Roastery") and a later one
    isn't ("G.H. Coffee Company"), the later one wins.
    """
    segs = [s.strip() for s in re.split(r"\s*[|\-–—]\s*", title) if s.strip()]
    if not segs:
        return title.strip()
    # strip a trailing "home" token from any segment
    segs = [re.sub(r"\s+home\s*$", "", s, flags=re.I).strip() for s in segs]
    if _is_generic(segs[0]):
        for s in reversed(segs[1:]):
            if s and not _is_generic(s):
                return s
    return segs[0]


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    out = []
    name = meta_content(html, "og:site_name") or title_tag(html)
    if name:
        # "Coffee Roastery - G.H. Coffee Company" -> "G.H. Coffee Company"
        # unescape entities: "Nunzio&#x27;s Kitchen" -> "Nunzio's Kitchen"
        short = brand_name_from_title(_html.unescape(name))
        out.append(Finding("identity.name", short or name, 0.85, [url]))
    tagline = meta_content(html, "og:description", "description")
    if tagline and len(tagline) > 10:
        out.append(Finding("identity.tagline", tagline, 0.8, [url]))
    return out


SKILL["run"] = run
