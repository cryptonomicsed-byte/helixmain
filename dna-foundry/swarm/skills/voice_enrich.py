"""Skill: voice_enrich — personality, description, and honest sonic identity.

Heuristic voice enrichment from the tone skill's output plus page copy:
  - personality: tone-combo -> concise sketch ("the knowledgeable regular")
  - description: one sentence composed from tone adjectives
  - sonic: ONLY when the site gives evidence (in-store music, playlists,
    events). Silence beats invention — most SMB sites say nothing here.
"""
import re

from agents.base import Finding
from skills._util import visible_text

SKILL = {
    "name": "voice_enrich",
    "version": "1.0.0",
    "description": "Personality sketch, voice description, evidence-only sonic identity.",
    "fields": ["voice.personality", "voice.description", "voice.sonic"],
}

_PERSONALITY = [
    ({"warm", "premium"}, "the knowledgeable regular — expert without the attitude"),
    ({"warm", "playful"}, "the friendly neighbor who remembers your name"),
    ({"warm", "professional"}, "the trusted local professional"),
    ({"premium", "bold"}, "the confident craftsman"),
    ({"playful", "bold"}, "the enthusiastic insider"),
    ({"professional", "premium"}, "the meticulous specialist"),
    ({"calm", "premium"}, "the quiet perfectionist"),
    ({"warm"}, "the welcoming host"),
    ({"professional"}, "the reliable expert"),
    ({"playful"}, "the cheerful enthusiast"),
    ({"premium"}, "the discerning artisan"),
    ({"bold"}, "the straight shooter"),
]

_SONIC_SIGNALS = [
    (r"live music|dj |playlist|in-store music|soundtrack", "in-store music mentioned"),
    (r"events?.{0,40}music|music.{0,40}events?", "hosts musical events"),
]


def run(ctx):
    html, url = ctx.get("html", ""), ctx.get("url", "")
    tones: set[str] = set(ctx.get("tones") or [])
    out = []
    if tones:
        personality = None
        for combo, sketch in _PERSONALITY:
            if combo <= tones:
                personality = sketch
                break
        if not personality:
            personality = "the " + ", ".join(sorted(tones)[:2]) + " host"
        out.append(Finding("voice.personality", personality, 0.55, [url]))
        desc = ("Speaks " + ", ".join(sorted(tones)) +
                " — the copy favors short, concrete sentences over hype.")
        out.append(Finding("voice.description", desc, 0.5, [url]))

    text = visible_text(html).lower()
    for pat, label in _SONIC_SIGNALS:
        if re.search(pat, text):
            out.append(Finding("voice.sonic", {
                "voice_type": None, "music_genre": None,
                "sound_keywords": [label]}, 0.5, [url]))
            break
    return out


SKILL["run"] = run
