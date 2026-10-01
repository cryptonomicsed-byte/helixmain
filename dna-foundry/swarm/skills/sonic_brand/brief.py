"""Skill-local config + brief builder for sonic branding.

The brief is the DNA: name, tagline, voice_type, music_genre, sound_keywords,
tone, sample phrases. Everything generated — voice logo, sonic logo, UI
sounds — derives from it, so a re-extracted brief regenerates a consistent
sound. The brief + structured generation prompts are ALWAYS produced, even
when no audio provider is configured: flipping a key later produces audio
with no code changes.
"""
from __future__ import annotations

import os
import re


def spoken_form(text: str) -> str:
    """TTS wants spoken form: spell out symbols, no markup."""
    text = text.replace("&", "and")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def build_brief(card: dict) -> dict:
    v = card.get("voice") or {}
    s = v.get("sonic") or {}
    ident = card.get("identity") or {}
    return {
        "business": ident.get("name") or "this business",
        "tagline": ident.get("tagline") or "",
        "elevator_pitch": ident.get("elevator_pitch") or "",
        "voice_type": s.get("voice_type"),
        "music_genre": s.get("music_genre"),
        "sound_keywords": s.get("sound_keywords") or [],
        "tone": v.get("tone") or [],
        "sample_phrases": (v.get("sample_phrases") or [])[:3],
    }


def voice_logo_script(brief: dict) -> str:
    """Spoken tagline/greeting in the brand voice. Short: one breath."""
    name = brief["business"]
    tag = brief["tagline"] or brief["elevator_pitch"]
    script = f"Welcome to {name}."
    if tag:
        # split on sentence boundaries (a capital follows the period, so
        # "G.H."-style abbreviations don't split); skip any sentence that
        # just repeats the business name; keep it to one breath
        sentences = [s.strip() for s in
                     re.split(r"(?<=[.!?])(?<!\b[A-Z][.!?])\s+(?=[A-Z0-9])",
                              tag) if s.strip()]
        pick = next((s for s in sentences if name.lower() not in s.lower()),
                    "")
        if pick and len(pick) < 100:
            script += f" {pick}"
    return spoken_form(script)


def generation_prompts(brief: dict) -> dict:
    """Structured generation prompts per asset. Stable: same brief -> same prompt."""
    name = brief["business"]
    genre = brief["music_genre"] or "warm acoustic"
    kws = ", ".join(brief["sound_keywords"][:5]) or "warm, welcoming"
    tone = ", ".join(brief["tone"][:4]) or "warm"
    vt = brief["voice_type"] or "warm, natural speaking voice"
    prompts = {
        "sonic_logo": {
            "prompt": (
                f"Brand mnemonic for {name} ({brief['tagline']}). "
                f"A 4-second sonic logo in the spirit of the Netflix ta-dum or Intel bong: "
                f"{genre}, {kws} mood, {tone} character. "
                "Opens with a soft attack, rises through two or three notes, "
                "resolves to a single warm chord that rings out cleanly. "
                "Ownable, hummable, unmistakable. No vocals, no speech."),
            "negative_prompt": "vocals, speech, muddy mix, harsh noise, long fade",
            "duration_s": 4,
            "format": "mp3",
        },
        "voice_logo": {
            "script": voice_logo_script(brief),
            "voice_direction": (
                f"Speak as the brand's own voice: {vt}. "
                f"Tone: {tone}. Unhurried, one breath, smile audible."),
            "voice_profile": os.environ.get("HELIX_TTS_VOICE", "avocado_v2:MAI_03"),
            "language": os.environ.get("HELIX_TTS_LANGUAGE", "en"),
            "format": "mp3",
        },
        "ui_sounds": {
            "notification": {
                "prompt": (f"Soft notification chime for {name}: {genre}, {kws}. "
                           "A single gentle wooden knock followed by a warm muted tone, "
                           "under one second, friendly not urgent."),
                "duration_s": 0.9, "format": "mp3"},
            "success": {
                "prompt": (f"Success confirm for {name}: {genre}, {kws}. "
                           "Two rising notes resolving up, bright but soft, "
                           "under 1.2 seconds."),
                "duration_s": 1.2, "format": "mp3"},
            "error": {
                "prompt": (f"Gentle error nudge for {name}: {genre}, {kws}. "
                           "A single low rounded tone, no buzz, no harshness, "
                           "under one second. Reassuring, not alarming."),
                "duration_s": 0.8, "format": "mp3"},
        },
    }
    return prompts
