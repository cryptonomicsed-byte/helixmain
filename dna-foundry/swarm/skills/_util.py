"""Shared HTML helpers for skills (not a skill itself)."""
import re
from html.parser import HTMLParser


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self._skip = max(0, self._skip - 1)

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)

    def text(self):
        return re.sub(r"\s+", " ", "".join(self.parts)).strip()


def visible_text(html: str) -> str:
    p = _Text()
    try:
        p.feed(html)
    except Exception:
        pass
    return p.text()


def meta_content(html: str, *names: str) -> str | None:
    for name in names:
        for pat in (
            rf'<meta[^>]+property=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']{re.escape(name)}["\']',
            rf'<meta[^>]+name=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']{re.escape(name)}["\']',
        ):
            m = re.search(pat, html, re.I)
            if m:
                return m.group(1).strip()
    return None


def title_tag(html: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def headings(html: str, level: int) -> list[str]:
    out = []
    for m in re.finditer(rf"<h{level}[^>]*>(.*?)</h{level}>", html, re.I | re.S):
        t = visible_text(m.group(1))
        if t and len(t) < 200:
            out.append(t)
    return out


def links(html: str) -> list[tuple[str, str]]:
    out = []
    for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I | re.S):
        href, label = m.group(1).strip(), visible_text(m.group(2))
        if href and not href.startswith(("#", "javascript:", "mailto:", "tel:")):
            out.append((href, label))
    return out


def looks_like_noise(t: str) -> bool:
    """Reject section headings and markup-concatenation artifacts as offerings.

    Menu items are noun phrases, not sentences: "Family owned and operated
    since 1970." is a heading. "TakeoutReady" / "Delivery30" are two
    elements glued by stripped markup.
    """
    if not t:
        return True
    if re.search(r"[a-z][A-Z]", t):
        return True  # glued elements: "TakeoutReady"
    compact = t.replace(" ", "")
    if re.search(r"[A-Za-z][0-9]|[0-9][A-Za-z]", compact):
        # digit glued to a word: "Delivery30" (but allow "17oz", "5lb")
        if not re.search(r"^\d+\s*(oz|lb|g|ml|pc|pcs)\b", t, re.I):
            return True
    if t.rstrip().endswith((".", "!", "?", "…")):
        return True  # sentences are headings, not items
    if ". " in t or "! " in t or "? " in t:
        return True
    return False
