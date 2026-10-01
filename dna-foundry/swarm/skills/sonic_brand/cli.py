#!/usr/bin/env python3
"""sonic_brand CLI — the skill that gives a business its sound.

The sonic-brand skill patches the Sound section of a CARD.md only.
It reads Identity and Voice to build briefs, renders what it can
(voice logo via TTS today; musical logo and UI tones staged until a
music-model key exists), then hands a Sound-shaped patch to the compiler,
which bumps the version, chains previous_hash, appends a changelog entry,
and re-emits CARD.md. The skill never touches Identity, Offer, Policy,
or anything else on the card.

Usage:
  python3 swarm/skills/sonic_brand/cli.py --card cards/<id>_org_v1.json \
      --md compiled/<id>_v1/CARD.md \
      --assets-dir foundry/assets [--only voice_logo,sonic_logo,ui_sounds] \
      [--voice-profile avocado_v2:MAI_03]

Writes the new card JSON next to --card with the bumped version, so the
JSON machine view stays in sync with CARD.md (parsed back from it).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
SWARM = SKILL_DIR.parent.parent
FOUNDRY = SWARM.parent
if str(SWARM) not in sys.path:
    sys.path.insert(0, str(SWARM))

from skills.sonic_brand.assets import generate_assets  # noqa: E402
from skills.sonic_brand.brief import build_brief, generation_prompts  # noqa: E402
from agents.base import utcnow  # noqa: E402

COMPILER_CLI = FOUNDRY / "compiler" / "dist" / "cli.js"
SOUND_KEYS = ("voice_logo", "sonic_logo", "ui_sounds")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", required=True, help="current card JSON (read for Identity/Voice)")
    ap.add_argument("--md", required=True, help="CARD.md to patch (the product)")
    ap.add_argument("--assets-dir", required=True)
    ap.add_argument("--only", default="voice_logo,sonic_logo,ui_sounds")
    ap.add_argument("--voice-profile", default=None)
    args = ap.parse_args()

    card_path = Path(args.card)
    md_path = Path(args.md)
    card = json.loads(card_path.read_text())
    before_version = card.get("version")

    brief = build_brief(card)   # reads identity.name + voice.tone; stops if missing
    prompts = generation_prompts(brief)
    patch, report = generate_assets(
        brief, prompts, args.assets_dir,
        only=[o.strip() for o in args.only.split(",") if o.strip()],
        voice_profile=args.voice_profile,
        card_id=card.get("id", "unknown"))

    # Sound-shaped patch only. The compiler enforces the restriction.
    sound_patch = {k: v for k, v in patch.items() if k in SOUND_KEYS and v}
    sources = [g["asset_ref"] for g in report["generated"]] or ["staged-brief"]
    sound_patch["provenance"] = {
        "sources": sources,
        "confidence": 0.9 if report["generated"] else 0.5,
        "extracted_at": utcnow(),
        "extractor_agent": "skill:sonic_brand",
    }
    gen = ", ".join(g["asset"] for g in report["generated"]) or "none"
    stub = ", ".join(s["asset"] for s in report["stubbed"]) or "none"
    sound_patch["changelog"] = (
        f"sonic-brand: rendered [{gen}] / staged [{stub}] "
        f"(prompts: {report['prompts']})")

    patch_file = md_path.parent / "sound-patch.json"
    patch_file.write_text(json.dumps(sound_patch, indent=2))
    r = subprocess.run(
        ["node", str(COMPILER_CLI), "--patch-sound", "--md", str(md_path),
         "--patch", str(patch_file)],
        capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[sonic_brand] patch-sound failed:\n{r.stderr}", file=sys.stderr)
        sys.exit(1)
    patch_file.unlink()

    # Sync the JSON machine view by parsing the new CARD.md back.
    r = subprocess.run(
        ["node", str(COMPILER_CLI), "--parse-md", "--md", str(md_path)],
        capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[sonic_brand] parse-back failed:\n{r.stderr}", file=sys.stderr)
        sys.exit(1)
    new_card = json.loads(r.stdout)
    org = new_card.get("organization_id", "org_unknown")
    out_name = f"{new_card['id']}_{org}_v{new_card['version']}.json"
    out_path = card_path.parent / out_name
    out_path.write_text(json.dumps(new_card, indent=2))

    print(f"[sonic_brand] card {new_card['id']}: v{before_version} -> v{new_card['version']} "
          f"(hash {str(new_card['hash'])[:12]}, prev {str(new_card.get('previous_hash'))[:12]})")
    print(f"[sonic_brand] brief: {brief['business']} | voice={brief['voice_type']} "
          f"| genre={brief['music_genre']} | keywords={brief['sound_keywords'][:4]}")
    for g in report["generated"]:
        print(f"[sonic_brand] GENERATED {g['asset']}: {g['asset_ref']} "
              f"({g['provider']}) -> {g['file']}")
    for s in report["stubbed"]:
        print(f"[sonic_brand] STUBBED   {s['asset']}: {s['reason'][:110]}")
    print(f"[sonic_brand] CARD.md patched in place: {md_path}")
    print(f"[sonic_brand] card JSON synced: {out_path}")


if __name__ == "__main__":
    main()
