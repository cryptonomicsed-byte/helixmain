"""Skill: sonic_brand — the card's sonic brief becomes real audio assets.

Takes the card's voice.sonic brief (voice_type, music_genre, sound_keywords —
ported from Sacred Core's BrandDNA) and generates the asset set:

  - voice_logo: spoken tagline/greeting. IMPLEMENTED via the bundled TTS CLI
    (config: HELIX_TTS_CLI / HELIX_TTS_VOICE / HELIX_TTS_LANGUAGE). Real audio today.
  - sonic_logo: the 3-5s brand mnemonic. Music-model slot in the model gateway
    (FAL_API_KEY / HELIX_MUSIC_MODEL); STUBBED until a key exists — same
    key-passthrough pattern as Sacred Core's fal provider.
  - ui_sounds: notification / success / error. Same music slot; stubbed.

The skill ALWAYS emits the brief + structured generation prompt (staged at
<assets_dir>/prompts/<card_id>-sonic-prompts.json), so flipping a key
produces audio with no code changes. Assets are content-addressed
(sha256:<hex>) at foundry/assets/<hex>.mp3 — immutable, versioned with the
card: regeneration mints a new hash on the new card version.

Standalone: python3 swarm/skills/sonic_brand/cli.py --card <card.json>
  --assets-dir foundry/assets [--only voice_logo,sonic_logo,ui_sounds]
"""
from __future__ import annotations

from .assets import generate_assets
from .brief import build_brief, generation_prompts

try:
    from agents.base import Finding
except ImportError:  # skill loaded without swarm on path (docs/tests)
    Finding = None  # type: ignore

SKILL = {
    "name": "sonic_brand",
    "version": "1.0.0",
    "description": "Generate sonic brand assets (voice logo via TTS; sonic logo + UI sounds via the music-model slot) from the card's sonic brief.",
    "fields": ["voice.sonic"],
}


def run(ctx: dict):
    """ctx: {card: dict, assets_dir: str, only: [..]?, voice_profile: str?}."""
    if Finding is None:
        raise RuntimeError("swarm/ must be on sys.path to run the sonic_brand skill")
    card = ctx["card"]
    brief = build_brief(card)
    prompts = generation_prompts(brief)
    patch, report = generate_assets(
        brief, prompts, ctx.get("assets_dir", "assets"),
        only=ctx.get("only"), voice_profile=ctx.get("voice_profile"),
        card_id=card.get("id", "unknown"))
    sources = [g["asset_ref"] for g in report["generated"]]
    if not sources:
        sources = [f"staged brief ({report['prompts']})"]
    finding = Finding("voice.sonic", patch, 0.9 if report["generated"] else 0.5,
                      sources)
    finding.extractor_agent = "skill:sonic_brand"
    return [finding]


SKILL["run"] = run
