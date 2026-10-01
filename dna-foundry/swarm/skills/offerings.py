"""Skill: offerings — products/services from nav links and headings."""
import re
from agents.base import Finding
from skills._util import links, visible_text, looks_like_noise

SKILL = {
    "name": "offerings",
    "version": "1.0.0",
    "description": "Derive offerings from navigation labels and list content.",
    "fields": ["offerings"],
}

_SKIP = {"home", "menu", "about", "about us", "contact", "contact us", "blog", "news",
         "faq", "faqs", "privacy", "privacy policy", "terms", "terms of service",
         "login", "sign in", "cart", "checkout", "search",
         "shop", "shop now", "order", "order online", "order now",
         "order online now", "products", "store", "services",
         "view menu", "see the full menu", "see full menu", "full menu",
         "view our menu"}



def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    out, seen = [], set()
    for href, label in links(html):
        lab = label.strip()
        if not lab or len(lab) > 40 or lab.lower() in _SKIP or lab.lower() in seen:
            continue
        if looks_like_noise(lab):
            continue
        if re.search(r"menu|service|product|shop|order|catering", href + lab, re.I):
            seen.add(lab.lower())
            out.append(Finding("offerings", {"name": lab}, 0.5, [url]))
    # list items under a "menu/services" heading are offerings too
    for m in re.finditer(r"<li[^>]*>(.*?)</li>", html, re.I | re.S):
        t = visible_text(m.group(1))
        looks_like_item = ("$" in t) or re.search(r"\b(coffee|tea|pastry|sandwich|cake|latte|espresso)\b", t, re.I)
        if 4 < len(t) < 60 and looks_like_item and not looks_like_noise(t):
            if t.lower() not in seen:
                seen.add(t.lower())
                out.append(Finding("offerings", {"name": t[:60]}, 0.45, [url]))
        if len(out) >= 10:
            break
    return out[:10]


SKILL["run"] = run
