"""Skill: tone — voice of the business from word choice."""
import re
from collections import Counter
from agents.base import Finding
from skills._util import visible_text, headings

SKILL = {
    "name": "tone",
    "version": "1.0.0",
    "description": "Infer tone adjectives and capture sample phrases from hero copy.",
    "fields": ["voice.tone", "voice.sample_phrases"],
}

_LEXICON = {
    "warm": ["welcome", "cozy", "friendly", "family", "neighborhood", "love", "home"],
    "playful": ["fun", "yum", "awesome", "delicious", "treat", "joy", "happy"],
    "professional": ["quality", "service", "trusted", "expert", "certified", "guarantee"],
    "bold": ["best", "bold", "unforgettable", "ultimate", "obsessed", "craft"],
    "calm": ["relax", "peaceful", "serene", "quiet", "gentle", "slow"],
    "affordable": ["affordable", "budget", "deal", "value", "cheap", "save"],
    "premium": ["premium", "luxury", "artisan", "handcrafted", "exclusive", "finest"],
}


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    text = visible_text(html).lower()
    words = re.findall(r"[a-z']+", text)
    counts = Counter(words)
    scored = []
    for tone, lex in _LEXICON.items():
        hits = sum(counts.get(w, 0) for w in lex)
        if hits >= 2:
            scored.append((tone, hits))
    out = []
    if scored:
        scored.sort(key=lambda x: -x[1])
        tones = [t for t, _ in scored[:3]]
        out.append(Finding("voice.tone", tones, 0.6, [url]))
    phrases = [h for h in headings(html, 1) + headings(html, 2) if 8 < len(h) < 120][:4]
    if phrases:
        out.append(Finding("voice.sample_phrases", phrases, 0.7, [url]))
    return out


SKILL["run"] = run
