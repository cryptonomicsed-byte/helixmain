"""Fetcher shared by agents. Supports http(s) and file:// (fixtures / local docs).
Respects a politeness cap on pages per run. No API keys required."""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

MAX_PAGES = 12
TIMEOUT = 15


def fetch(url: str) -> tuple[str, str] | None:
    """Return (final_url, html) or None."""
    try:
        if url.startswith("file://"):
            p = Path(urlparse(url).path)
            if p.is_file():
                return url, p.read_text(errors="ignore")
            # allow directory -> index.html
            idx = p / "index.html"
            if idx.is_file():
                return url, idx.read_text(errors="ignore")
            return None
        r = requests.get(url, timeout=TIMEOUT,
                         headers={"User-Agent": "HelixDNAFoundry/0.1 (extraction bot)"})
        if r.status_code == 200 and "html" in r.headers.get("Content-Type", ""):
            return r.url, r.text
        return None
    except Exception:
        return None


def internal_links(base_url: str, html: str, limit: int = 10) -> list[str]:
    from skills._util import links
    base = urlparse(base_url)
    out = []
    for href, _label in links(html):
        full = urljoin(base_url, href)
        u = urlparse(full)
        if base.scheme == u.scheme and base.netloc == u.netloc and full not in out:
            if base.scheme == "file" or True:
                out.append(full)
        if len(out) >= limit:
            break
    return out


DOC_HINTS = ("about", "faq", "polic", "terms", "privacy", "service", "menu",
             "review", "testimonial", "shipping", "return", "refund")


def interesting_links(base_url: str, html: str) -> list[str]:
    """Subset of internal links that look like documents worth extracting."""
    return [u for u in internal_links(base_url, html)
            if any(h in u.lower() for h in DOC_HINTS)][:8]
