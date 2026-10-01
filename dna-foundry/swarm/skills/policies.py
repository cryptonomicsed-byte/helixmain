"""Skill: policies — operating policies from policy/terms/faq pages."""
import re
from agents.base import Finding
from skills._util import visible_text

SKILL = {
    "name": "policies",
    "version": "1.0.0",
    "description": "Extract return/refund/cancellation/escalation policies from legal pages.",
    "fields": ["policies", "knowledge"],
}

_TOPICS = {
    "returns": r"return",
    "refunds": r"refund",
    "cancellations": r"cancel",
    "shipping": r"ship|deliver",
    "privacy": r"privacy|personal (data|information)",
    "escalation": r"complaint|dispute|escalat",
}


def _sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if 20 < len(s) < 400]


def run(ctx):
    pages = ctx.get("pages", {})
    out = []
    for url, html in pages.items():
        if not re.search(r"polic|terms|privacy|faq|return|refund|shipping", url, re.I):
            continue
        text = visible_text(html)
        for topic, pat in _TOPICS.items():
            for s in _sentences(text):
                if re.search(pat, s, re.I):
                    out.append(Finding("policies", {"topic": topic, "rule": s[:300]}, 0.65, [url]))
                    break  # one rule per topic per page
        if re.search(r"polic|terms|faq", url, re.I):
            kind = "faq" if "faq" in url.lower() else "policy_doc"
            out.append(Finding("knowledge", {
                "ref": url, "kind": kind,
                "title": url.rstrip("/").split("/")[-1].replace("-", " ").title() or "Policy",
                "chunks": max(1, len(text) // 2000),
            }, 0.8, [url]))
    # dedupe policies by topic, keep highest confidence; drop topics whose
    # rule text is identical to another topic's (keyword leaked from a shared heading)
    best = {}
    for f in out:
        if f.field != "policies":
            continue
        t = f.value["topic"]
        if t not in best or f.confidence > best[t].confidence:
            best[t] = f
    seen_rules = set()
    deduped = []
    for t, f in best.items():
        key = f.value["rule"].strip().lower()
        if key in seen_rules:
            continue
        seen_rules.add(key)
        deduped.append(f)
    return deduped + [f for f in out if f.field != "policies"]


SKILL["run"] = run
