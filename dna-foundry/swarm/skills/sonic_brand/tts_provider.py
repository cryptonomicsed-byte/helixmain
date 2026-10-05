"""TTS provider for the voice logo.

Provider chain (first available wins):
  1. kokoro-onnx  — local ONNX inference, no key, no external call.
                    Model files (~320 MB) live in HELIX_KOKORO_DIR
                    (default ~/.helix/kokoro/). Download once with:
                      python -m helix.tools.fetch_kokoro
                    or manually from:
                      https://github.com/thewh1teagle/kokoro-onnx/releases
  2. bundled CLI  — /opt/hatch/bin/tts (cloud-backed, HELIX_TTS_CLI).
  3. TTSUnavailable — voice logo stays a staged brief; no error for the run.

Config (env):
  HELIX_KOKORO_DIR    directory containing kokoro-v1.0.onnx + voices-v1.0.bin
  HELIX_KOKORO_VOICE  kokoro voice id (default af_heart)
  HELIX_TTS_CLI       path to the bundled tts binary (default /opt/hatch/bin/tts)
  HELIX_TTS_VOICE     voice id for the bundled CLI (default avocado_v2:MAI_03)
  HELIX_TTS_LANGUAGE  language code (default en)
"""
from __future__ import annotations

import os
import shutil
import subprocess

DEFAULT_CLI = "/opt/hatch/bin/tts"
DEFAULT_CLI_VOICE = "avocado_v2:MAI_03"
DEFAULT_KOKORO_VOICE = "af_heart"
KOKORO_MODEL_FILE = "kokoro-v1.0.onnx"
KOKORO_VOICES_FILE = "voices-v1.0.bin"


class TTSUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def _kokoro_dir() -> str:
    return os.path.expanduser(
        os.environ.get("HELIX_KOKORO_DIR", "~/.helix/kokoro"))


def tts_status() -> dict:
    kdir = _kokoro_dir()
    kokoro_ready = (
        os.path.exists(os.path.join(kdir, KOKORO_MODEL_FILE)) and
        os.path.exists(os.path.join(kdir, KOKORO_VOICES_FILE))
    )
    cli = os.environ.get("HELIX_TTS_CLI", DEFAULT_CLI)
    cli_found = bool(shutil.which(cli) or (cli if os.access(cli, os.X_OK) else None))
    provider = "kokoro" if kokoro_ready else ("bundled-tts-cli" if cli_found else "unavailable")
    return {
        "provider": provider,
        "kokoro_ready": kokoro_ready,
        "kokoro_dir": kdir,
        "kokoro_voice": os.environ.get("HELIX_KOKORO_VOICE", DEFAULT_KOKORO_VOICE),
        "cli": cli,
        "cli_found": cli_found,
        "voice": os.environ.get("HELIX_TTS_VOICE", DEFAULT_CLI_VOICE),
        "language": os.environ.get("HELIX_TTS_LANGUAGE", "en"),
    }


# ---------------------------------------------------------------------------
# Kokoro path
# ---------------------------------------------------------------------------

def _synthesize_kokoro(script: str, out_path: str, voice: str,
                        lang: str, timeout: int) -> str:
    """Local ONNX inference via kokoro-onnx. Returns out_path."""
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
    except ImportError as e:
        raise TTSUnavailable(
            f"kokoro-onnx not importable: {e}. Run: uv sync") from e

    kdir = _kokoro_dir()
    model_path = os.path.join(kdir, KOKORO_MODEL_FILE)
    voices_path = os.path.join(kdir, KOKORO_VOICES_FILE)
    if not os.path.exists(model_path) or not os.path.exists(voices_path):
        raise TTSUnavailable(
            f"kokoro model files not found in {kdir}. "
            "Download kokoro-v1.0.onnx and voices-v1.0.bin from "
            "https://github.com/thewh1teagle/kokoro-onnx/releases "
            "and place them in HELIX_KOKORO_DIR.")

    kk = Kokoro(model_path, voices_path)
    samples, sample_rate = kk.create(script, voice=voice, speed=1.0, lang=lang)

    if out_path.endswith(".mp3"):
        wav_path = out_path[:-4] + ".wav"
        sf.write(wav_path, samples, sample_rate)
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", wav_path, "-q:a", "4", out_path],
            capture_output=True, timeout=30)
        os.unlink(wav_path)
        if r.returncode != 0:
            raise TTSUnavailable(
                f"ffmpeg mp3 conversion failed: {r.stderr.decode()[:200]}")
    else:
        sf.write(out_path, samples, sample_rate)

    return out_path


# ---------------------------------------------------------------------------
# Bundled CLI path
# ---------------------------------------------------------------------------

def _synthesize_cli(script: str, voice_profile: str, out_path: str,
                     language: str, timeout: int) -> str:
    """Bundled /opt/hatch/bin/tts CLI (cloud-backed). Returns out_path."""
    st = tts_status()
    if not st["cli_found"]:
        raise TTSUnavailable(
            f"tts CLI not found at {st['cli']} (HELIX_TTS_CLI). "
            "Voice logo stays a staged brief until the CLI is available.")
    cmd = [st["cli"], "speak", "--output", out_path, "--voice", voice_profile,
           "--language", language, "--format", "mp3", "--text-stdin"]
    try:
        r = subprocess.run(cmd, input=script.encode(), capture_output=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise TTSUnavailable(f"tts timed out after {timeout}s: {e}") from e
    if r.returncode != 0 or not os.path.exists(out_path):
        raise TTSUnavailable(
            f"tts failed (rc={r.returncode}): {r.stderr.decode()[:300]}")
    return out_path


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def synthesize_voice_logo(script: str, voice_profile: str, out_path: str,
                           language: str = "en", timeout: int = 120) -> str:
    """Synthesize the voice logo script. Returns out_path. Raises TTSUnavailable."""
    kokoro_voice = os.environ.get("HELIX_KOKORO_VOICE", DEFAULT_KOKORO_VOICE)
    kokoro_lang = "en-us" if language.startswith("en") else language
    last_err: TTSUnavailable | None = None

    try:
        return _synthesize_kokoro(script, out_path, kokoro_voice, kokoro_lang, timeout)
    except TTSUnavailable as e:
        last_err = e

    try:
        return _synthesize_cli(script, voice_profile, out_path, language, timeout)
    except TTSUnavailable as e:
        last_err = e

    raise last_err  # type: ignore[misc]
