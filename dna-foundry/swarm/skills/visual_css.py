"""Skill: visual_css — REAL visual identity from stylesheets.

Sacred Core's weakness: it asks the LLM to guess hex colors from page text.
This skill does the opposite: parse linked stylesheets + inline <style>
blocks, count actual color and font-family declarations by frequency, and
report the measured palette. The LLM (visual agent prompt) only interprets
style — it never invents a hex code.
"""
import re
from collections import Counter
from urllib.parse import urljoin

from agents.base import Finding
from agents.fetcher import fetch

SKILL = {
    "name": "visual_css",
    "version": "1.0.0",
    "description": "Measure brand colors and fonts from real CSS (frequency-counted).",
    "fields": ["visual.primary_color", "visual.secondary_color", "visual.font_pairing"],
}

_HEX = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b")
_RGB = re.compile(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})")
_FONT = re.compile(r"font-family\s*:\s*([^;{}]+)")
_CSS_LINK = re.compile(r'<link[^>]+rel=["\']stylesheet["\'][^>]*>', re.I)
_HREF = re.compile(r'href=["\']([^"\']+)["\']', re.I)
_STYLE_BLOCK = re.compile(r"<style[^>]*>(.*?)</style>", re.I | re.S)

# near-black / near-white / transparent-ish: not brand colors
_NEUTRAL = {
    (0, 0, 0), (255, 255, 255),
}


def _norm_hex(h: str) -> str:
    h = h.lower()
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "#" + h


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _is_neutral(h: str) -> bool:
    try:
        r, g, b = _hex_to_rgb(h)
    except ValueError:
        return True
    if (r, g, b) in _NEUTRAL:
        return True
    # near-grays: all channels within 12 of each other and very dark/light
    if max(r, g, b) - min(r, g, b) < 12 and (max(r, g, b) < 24 or min(r, g, b) > 232):
        return True
    return False


def _css_texts(page_url: str, html: str) -> list[str]:
    texts = [m.group(1) for m in _STYLE_BLOCK.finditer(html)]
    for tag in _CSS_LINK.finditer(html):
        hm = _HREF.search(tag.group(0))
        if not hm:
            continue
        css_url = urljoin(page_url, hm.group(1))
        if css_url.startswith("file://"):
            continue  # fixtures have no stylesheets; skip quietly
        got = fetch(css_url)
        if got and len(got[1]) < 2_000_000:
            texts.append(got[1])
    return texts


def run(ctx):
    pages: dict[str, str] = ctx.get("pages", {})
    if not pages and ctx.get("html"):
        pages = {ctx.get("url", ""): ctx["html"]}
    colors: Counter = Counter()
    fonts: Counter = Counter()
    css_sources = 0
    for url, html in pages.items():
        for css in _css_texts(url, html):
            css_sources += 1
            for m in _HEX.finditer(css):
                colors[_norm_hex(m.group(1))] += 1
            for m in _RGB.finditer(css):
                r, g, b = (min(255, int(x)) for x in m.groups())
                colors[_rgb_to_hex(r, g, b)] += 1
            for m in _FONT.finditer(css):
                fams = [f.strip().strip("\"'") for f in m.group(1).split(",")]
                fams = [f for f in fams if f and f.lower() not in
                        ("inherit", "initial", "unset")]
                for f in fams[:2]:  # primary + first fallback carry the signal
                    fonts[f] += 1
    out = []
    src_urls = list(pages.keys())
    ranked = [(c, n) for c, n in colors.most_common(12) if not _is_neutral(c)]
    if ranked:
        primary, n1 = ranked[0]
        out.append(Finding("visual.primary_color", primary, 0.9, src_urls))
        if len(ranked) > 1:
            out.append(Finding("visual.secondary_color", ranked[1][0], 0.85, src_urls))
    top_fonts = [f for f, _ in fonts.most_common(4)]
    if top_fonts:
        pairing = " / ".join(top_fonts[:2])
        out.append(Finding("visual.font_pairing", pairing, 0.9, src_urls))
    return out


SKILL["run"] = run
