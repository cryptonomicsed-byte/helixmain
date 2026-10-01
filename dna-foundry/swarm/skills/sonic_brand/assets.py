"""Asset generation orchestration for the sonic_brand skill.

generate_assets(brief, prompts, assets_dir, only, voice_profile)
  -> (sonic_patch, report)

The patch is a voice.sonic-shaped dict: {voice_logo: {...}, sonic_logo: {...},
ui_sounds: [...]} — only for assets that were requested. Generated assets get
a sha256 asset_ref and an immutable file at <assets_dir>/<hash>.mp3 (reused
when the hash already exists: content-addressed, never overwritten). Stubbed
assets keep the brief with asset_ref None, plus the generation prompt staged
in <assets_dir>/prompts/<card_id>-sonic-prompts.json.

Versioning: assets are immutable and version WITH the card — a regenerated
asset mints a new hash, recorded on the new card version. Old files are kept
so the hash chain stays resolvable.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from .brief import generation_prompts  # noqa: F401  (re-export for callers)
from .tts_provider import synthesize_voice_logo, tts_status, TTSUnavailable
from .music_provider import generate_music, music_status, MusicProviderStubbed

ASSET_EXT = "mp3"


def _store_asset(assets_dir: Path, tmp_path: str) -> tuple[str, Path]:
    digest = hashlib.sha256(Path(tmp_path).read_bytes()).hexdigest()
    dest = assets_dir / f"{digest}.{ASSET_EXT}"
    if not dest.exists():
        Path(tmp_path).replace(dest)  # atomic; content-addressed, never overwritten
    else:
        Path(tmp_path).unlink(missing_ok=True)
    return f"sha256:{digest}", dest


def generate_assets(brief: dict, prompts: dict, assets_dir: str,
                    only: list[str] | None = None,
                    voice_profile: str | None = None,
                    card_id: str = "unknown") -> tuple[dict, dict]:
    only = only or ["voice_logo", "sonic_logo", "ui_sounds"]
    assets_dir = Path(assets_dir)
    assets_dir.mkdir(parents=True, exist_ok=True)

    # The brief + structured prompts are ALWAYS staged, even when every
    # provider is stubbed. Flipping a key later -> re-run -> audio, no code changes.
    prompt_path = assets_dir / "prompts" / f"{card_id}-sonic-prompts.json"
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    prompt_path.write_text(json.dumps(
        {"card_id": card_id, "brief": brief, "prompts": prompts,
         "tts": tts_status(), "music": music_status()}, indent=2))

    patch: dict = {}
    report: dict = {"generated": [], "stubbed": [], "prompts": str(prompt_path)}

    if "voice_logo" in only:
        vp = prompts["voice_logo"]
        profile = voice_profile or vp["voice_profile"]
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False, dir=str(assets_dir)) as t:
                tmp = t.name
            synthesize_voice_logo(vp["script"], profile, tmp, vp["language"])
            ref, dest = _store_asset(assets_dir, tmp)
            patch["voice_logo"] = {"script": vp["script"],
                                   "voice_profile": profile,
                                   "asset_ref": ref}
            report["generated"].append(
                {"asset": "voice_logo", "asset_ref": ref, "file": str(dest),
                 "provider": "bundled-tts-cli", "voice_profile": profile})
        except TTSUnavailable as e:
            patch["voice_logo"] = {"script": vp["script"],
                                   "voice_profile": profile,
                                   "asset_ref": None}
            report["stubbed"].append({"asset": "voice_logo", "reason": str(e)})

    if "sonic_logo" in only:
        sp = prompts["sonic_logo"]
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False, dir=str(assets_dir)) as t:
                tmp = t.name
            generate_music(sp["prompt"], sp["duration_s"], tmp, kind="sonic_logo")
            ref, dest = _store_asset(assets_dir, tmp)
            patch["sonic_logo"] = {"description": sp["prompt"][:220],
                                   "asset_ref": ref,
                                   "duration_s": sp["duration_s"]}
            report["generated"].append(
                {"asset": "sonic_logo", "asset_ref": ref, "file": str(dest),
                 "provider": music_status()["provider"]})
        except (MusicProviderStubbed, Exception) as e:
            patch["sonic_logo"] = {"description": sp["prompt"][:220],
                                   "asset_ref": None,
                                   "duration_s": sp["duration_s"]}
            report["stubbed"].append(
                {"asset": "sonic_logo",
                 "reason": str(e) if isinstance(e, MusicProviderStubbed)
                 else f"music provider error: {e}"})

    if "ui_sounds" in only:
        ui = []
        for name, up in prompts["ui_sounds"].items():
            try:
                with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False, dir=str(assets_dir)) as t:
                    tmp = t.name
                generate_music(up["prompt"], up["duration_s"], tmp,
                               kind=f"ui_{name}")
                ref, dest = _store_asset(assets_dir, tmp)
                ui.append({"name": name, "description": up["prompt"][:160],
                           "asset_ref": ref})
                report["generated"].append(
                    {"asset": f"ui_sounds.{name}", "asset_ref": ref,
                     "file": str(dest), "provider": music_status()["provider"]})
            except (MusicProviderStubbed, Exception) as e:
                ui.append({"name": name, "description": up["prompt"][:160],
                           "asset_ref": None})
                report["stubbed"].append(
                    {"asset": f"ui_sounds.{name}",
                     "reason": str(e) if isinstance(e, MusicProviderStubbed)
                     else f"music provider error: {e}"})
        patch["ui_sounds"] = ui

    report["env"] = {
        "HELIX_TTS_VOICE": os.environ.get("HELIX_TTS_VOICE", "(default)"),
        "FAL_API_KEY": "set" if os.environ.get("FAL_API_KEY") else "unset",
        "HELIX_MUSIC_MODEL": os.environ.get("HELIX_MUSIC_MODEL", "(default fal-ai/stable-audio)"),
    }
    return patch, report
