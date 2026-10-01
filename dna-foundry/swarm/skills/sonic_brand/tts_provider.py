"""TTS provider for the voice logo — implemented for real.

Uses the bundled `tts` CLI (/opt/hatch/bin/tts, see the `tts` skill).
No API key: the CLI is part of the runtime.

Config (env):
  HELIX_TTS_CLI       path to the tts binary (default /opt/hatch/bin/tts)
  HELIX_TTS_VOICE     voice id from the voice catalog (default avocado_v2:MAI_03, Smooth)
  HELIX_TTS_LANGUAGE  language code (default en)

Raises TTSUnavailable when the CLI is missing or synthesis fails — the caller
then keeps the staged brief (asset_ref null) instead of failing the run.
"""
from __future__ import annotations

import os
import shutil
import subprocess

DEFAULT_CLI = "/opt/hatch/bin/tts"
DEFAULT_VOICE = "avocado_v2:MAI_03"


class TTSUnavailable(RuntimeError):
    pass


def tts_status() -> dict:
    cli = os.environ.get("HELIX_TTS_CLI", DEFAULT_CLI)
    found = shutil.which(cli) or (cli if os.access(cli, os.X_OK) else None)
    return {"provider": "bundled-tts-cli" if found else "unavailable",
            "cli": cli, "found": bool(found),
            "voice": os.environ.get("HELIX_TTS_VOICE", DEFAULT_VOICE),
            "language": os.environ.get("HELIX_TTS_LANGUAGE", "en")}


def synthesize_voice_logo(script: str, voice_profile: str, out_path: str,
                           language: str = "en", timeout: int = 120) -> str:
    """Synthesize the voice logo script. Returns out_path. Raises TTSUnavailable."""
    st = tts_status()
    if not st["found"]:
        raise TTSUnavailable(
            f"tts CLI not found at {st['cli']} (HELIX_TTS_CLI). "
            "Voice logo stays a staged brief until the CLI is available.")
    cmd = [st["cli"], "speak", "--output", out_path, "--voice", voice_profile,
           "--language", language, "--format", "mp3", "--text-stdin"]
    try:
        r = subprocess.run(cmd, input=script.encode(), capture_output=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise TTSUnavailable(f"tts timed out after {timeout}s: {e}")
    if r.returncode != 0 or not os.path.exists(out_path):
        raise TTSUnavailable(
            f"tts failed (rc={r.returncode}): {r.stderr.decode()[:300]}")
    return out_path
