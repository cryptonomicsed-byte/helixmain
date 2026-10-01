"""Crawl planner — multi-page discovery with per-agent page ownership.

Sacred Core scrapes ONE page. A business is not one page. The planner:
  1. discovers pages via sitemap.xml (following one level of sub-sitemaps),
     falling back to the homepage link graph;
  2. classifies each page into a bucket (about, offerings, contact,
     policies, faq, pricing, reviews);
  3. assigns buckets to agents — each agent owns its pages.

No API keys. Politeness-capped.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlparse

from agents.fetcher import fetch, internal_links

MAX_SITEMAP_URLS = 200

BUCKET_PATTERNS: list[tuple[str, str]] = [
    ("about", r"about|our-story|story|mission|team|who-we-are"),
    ("offerings", r"menu|services|products?|shop|collections?|wholesale|catering|subscription|classes|brewing"),
    ("contact", r"contact|locations?|visit|find-us|stores?"),
    ("policies", r"privacy|terms|shipping|returns?|refunds?|accessibility|compliance|gdpr|ccpa|legal"),
    ("faq", r"faq|faqs|help|support"),
    ("pricing", r"pricing|plans?"),
    ("reviews", r"reviews?|testimonials?"),
]

# agent -> buckets it owns
OWNERSHIP = {
    "extractor:website": ["home", "about"],
    "extractor:documents": ["policies", "faq"],
    "extractor:reviews": ["reviews"],
    "extractor:strategy": ["offerings", "pricing", "about"],
    "extractor:visual": ["home", "offerings"],
    "extractor:competitor": ["home", "about", "offerings"],
}


def classify_page(url: str) -> str:
    path = urlparse(url).path.lower()
    for bucket, pat in BUCKET_PATTERNS:
        if re.search(pat, path):
            return bucket
    return "other"


def _sitemap_urls(base_url: str) -> list[str]:
    """sitemap.xml -> sub-sitemaps -> page URLs. One level of nesting."""
    got = fetch(urljoin(base_url, "/sitemap.xml"))
    if not got:
        return []
    _, xml = got
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [e.text.strip() for e in root.findall(".//s:loc", ns) if e.text]
    if not locs:  # try without namespace
        locs = [e.text.strip() for e in root.iter("loc") if e.text]
    # sub-sitemap index?
    if any("sitemap" in u.lower() and u.lower().endswith(".xml") or "sitemap_" in u for u in locs[:5]):
        pages: list[str] = []
        for sm in locs[:10]:
            g = fetch(sm)
            if not g:
                continue
            try:
                r2 = ET.fromstring(g[1])
            except ET.ParseError:
                continue
            for e in r2.findall(".//s:loc", ns):
                if e.text:
                    pages.append(e.text.strip())
            if not pages:
                for e in r2.iter("loc"):
                    if e.text:
                        pages.append(e.text.strip())
            if len(pages) >= MAX_SITEMAP_URLS:
                break
        return pages[:MAX_SITEMAP_URLS]
    return [u for u in locs if not u.lower().endswith(".xml")][:MAX_SITEMAP_URLS]


def crawl_plan(base_url: str, max_pages: int = 14) -> dict:
    """Return {buckets: {bucket: [urls]}, home: url}.

    Prefers sitemap discovery; falls back to the homepage link graph.
    Caps total pages for politeness and cost.
    """
    parsed = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    urls = _sitemap_urls(origin)
    if not urls:
        got = fetch(base_url)
        if got:
            final, html = got
            urls = internal_links(final, html, limit=max_pages)
    # always include the homepage itself
    home = base_url if base_url.startswith("http") else origin + "/"
    seen = {home}
    buckets: dict[str, list[str]] = {}
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        b = classify_page(u)
        buckets.setdefault(b, []).append(u)
    # cap per bucket, keep total bounded
    total = 1
    for b in buckets:
        buckets[b] = buckets[b][:4]
        total += len(buckets[b])
    # trim overflow from the least valuable buckets first
    for b in ("other", "policies", "faq"):
        while total > max_pages and buckets.get(b):
            buckets[b].pop()
            total -= 1
    return {"home": home, "buckets": buckets}


def pages_for_agent(plan: dict, agent: str) -> list[str]:
    out: list[str] = []
    for bucket in OWNERSHIP.get(agent, []):
        if bucket == "home":
            out.append(plan["home"])
        else:
            out.extend(plan["buckets"].get(bucket, []))
    # de-dupe, preserve order
    return list(dict.fromkeys(out))
