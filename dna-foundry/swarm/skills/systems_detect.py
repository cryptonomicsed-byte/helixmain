"""Skill: systems_detect — platform fingerprints -> operations.systems.

Detects the stack the business already runs on (Shopify, WordPress, Wix,
Squarespace, Square, Klaviyo...). The Agent OS needs to know what exists
before it connects to anything.
"""
import re

from agents.base import Finding

SKILL = {
    "name": "systems_detect",
    "version": "1.0.0",
    "description": "Fingerprint the site's platform stack.",
    "fields": ["operations.systems"],
}

_SIGNALS = [
    ("shopify", [r"myshopify\.com", r"cdn\.shopify\.com", r"Shopify\.theme"]),
    ("wordpress", [r"wp-content", r"wp-includes", r"/wp-json/"]),
    ("wix", [r"wixstatic\.com", r"wix\.com"]),
    ("squarespace", [r"squarespace", r"static1\.squarespace"]),
    ("square", [r"squareup\.com", r"square\.site"]),
    ("klaviyo", [r"klaviyo"]),
    ("mailchimp", [r"mailchimp", r"list-manage\.com"]),
    ("hubspot", [r"hs-scripts\.com", r"hubspot"]),
    ("google_analytics", [r"googletagmanager\.com", r"google-analytics\.com"]),
    ("meta_pixel", [r"connect\.facebook\.net"]),
    ("tiktok_pixel", [r"analytics\.tiktok\.com"]),
]


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    found = []
    for name, pats in _SIGNALS:
        if any(re.search(p, html, re.I) for p in pats):
            found.append(name)
    if found:
        return [Finding("operations.systems", found, 0.9, [url])]
    return []


SKILL["run"] = run
