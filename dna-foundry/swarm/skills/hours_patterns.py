"""Skill: hours_patterns — operating hours from day/time patterns."""
import re
from agents.base import Finding
from skills._util import visible_text

SKILL = {
    "name": "hours_patterns",
    "version": "1.0.0",
    "description": "Detect operating-hours statements like 'Mon–Fri 9am–5pm'.",
    "fields": ["operations.hours"],
}

_DAYS = r"(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)"
_TIME = r"\d{1,2}(?::\d{2})?\s*(?:am|pm)"
_HOURS = re.compile(
    rf"{_DAYS}(?:\s*[–\-to]+\s*{_DAYS})?\s*:?\s*{_TIME}\s*[–\-to]+\s*{_TIME}",
    re.I,
)


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    text = visible_text(html)
    found = []
    for m in _HOURS.finditer(text):
        s = re.sub(r"\s+", " ", m.group(0)).strip()
        if s not in found:
            found.append(s)
    if not found:
        return []
    return [Finding("operations.hours", "; ".join(found[:4]), 0.75, [url])]


SKILL["run"] = run
