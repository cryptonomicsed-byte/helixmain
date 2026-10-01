"""Skill: pricing — price patterns and Shopify product feeds.

Pricing signals: $X, from $X, $X/mo. For Shopify storefronts, /products.json
is a goldmine: real product names + variant prices, no guessing.
"""
import re
from urllib.parse import urlparse

from agents.base import Finding
from agents.fetcher import fetch
from skills._util import visible_text

SKILL = {
    "name": "pricing",
    "version": "1.0.0",
    "description": "Mine price hints from page text and Shopify product feeds.",
    "fields": ["offerings"],
}

_PRICE = re.compile(r"(?:from|starting at|only)\s*\$[\d,]+(?:\.\d{2})?|\$[\d,]+(?:\.\d{2})?\s*(?:/|per|a)?\s*(?:month|mo|bag|box)?", re.I)


def _shopify_products(origin: str) -> list[dict]:
    out = []
    try:
        import json as _json
        got = fetch(origin + "/products.json?limit=50")
        if not got:
            return out
        data = _json.loads(got[1])
        for p in data.get("products", [])[:30]:
            prices = [v.get("price") for v in p.get("variants", []) if v.get("price")]
            price = min(prices) if prices else None
            out.append({"name": p.get("title", "")[:80],
                        "price_hint": f"from ${price}" if price else None})
    except Exception:
        pass
    return [p for p in out if p["name"]]


def run(ctx):
    pages: dict[str, str] = ctx.get("pages", {})
    if not pages and ctx.get("html"):
        pages = {ctx.get("url", ""): ctx["html"]}
    out = []
    seen: set[str] = set()
    # Shopify fast path
    origins = {f"{urlparse(u).scheme}://{urlparse(u).netloc}" for u in pages if urlparse(u).netloc}
    for origin in origins:
        for p in _shopify_products(origin):
            key = p["name"].lower()
            if key not in seen:
                seen.add(key)
                out.append(Finding("offerings", p, 0.85, [origin + "/products.json"]))
    # text price patterns, attached to nearby offering-ish nouns
    for url, html in pages.items():
        text = visible_text(html)
        for m in _PRICE.finditer(text):
            start = max(0, m.start() - 60)
            context = text[start:m.end()].strip()
            noun = re.findall(r"([A-Z][a-zA-Z&'’\- ]{2,30})\s*$", context)
            label = (noun[-1].strip() if noun else "offering")[:40]
            price = m.group(0).strip()
            key = (label + price).lower()
            if key not in seen and len(out) < 20:
                seen.add(key)
                out.append(Finding("offerings",
                                   {"name": label, "price_hint": price}, 0.5, [url]))
    return out


SKILL["run"] = run
