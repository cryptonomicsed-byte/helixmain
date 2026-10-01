"""Skill: contact_info — location, phone, email, channels from page text."""
import re
from agents.base import Finding
from skills._util import visible_text

SKILL = {
    "name": "contact_info",
    "version": "1.0.0",
    "description": "Extract phone, email, street address and infer contact channels.",
    "fields": ["identity.location", "operations.channels"],
}

_PHONE = re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}")
_EMAIL = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_ADDR = re.compile(
    r"\d{1,5}\s+[A-Z][a-zA-Z0-9.'’\- ]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Plaza|Court|Ct)\b[^,.\n]{0,40}",
)


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    text = visible_text(html)
    out = []
    phones = _PHONE.findall(text)
    channels = []
    if phones or "tel:" in html:
        channels.append("phone")
    if _EMAIL.search(text):
        channels.append("email")
    if channels:
        out.append(Finding("operations.channels", channels, 0.9, [url]))
    m = _ADDR.search(text)
    if m:
        out.append(Finding("identity.location", m.group(0).strip(), 0.7, [url]))
    return out


SKILL["run"] = run
