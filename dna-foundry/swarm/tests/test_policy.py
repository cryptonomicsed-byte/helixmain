"""CI policy checks for the dna-swarm package.

Three invariants:
  1. ACTING_KEYS parity — Python canonical.py must match TypeScript dist/index.js exactly.
  2. Swarm importability — all top-level Python modules import clean.
  3. TTS fallback chain — synthesize_voice_logo raises TTSUnavailable (not a hard crash)
     when kokoro model files and the CLI binary are both absent.
"""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

SWARM_DIR = Path(__file__).parent.parent
COMPILER_DIST = SWARM_DIR.parent / "compiler" / "dist" / "index.js"


# ---------------------------------------------------------------------------
# 1. ACTING_KEYS parity
# ---------------------------------------------------------------------------

def _ts_acting_keys() -> list[str]:
    """Read ACTING_KEYS from the compiled TypeScript dist."""
    result = subprocess.run(
        ["node", "-e",
         f"const {{ACTING_KEYS}} = require({json.dumps(str(COMPILER_DIST))});"
         "process.stdout.write(JSON.stringify(ACTING_KEYS));"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        pytest.skip(f"node/dist unavailable: {result.stderr[:200]}")
    return json.loads(result.stdout)


def test_acting_keys_parity():
    """Python ACTING_KEYS must be byte-identical to the TypeScript version."""
    from canonical import ACTING_KEYS as py_keys
    ts_keys = _ts_acting_keys()
    assert list(py_keys) == ts_keys, (
        f"ACTING_KEYS mismatch.\n"
        f"  Python : {list(py_keys)}\n"
        f"  TypeScript: {ts_keys}\n"
        "Update one side so they match."
    )


# ---------------------------------------------------------------------------
# 2. Swarm importability
# ---------------------------------------------------------------------------

TOP_LEVEL_MODULES = [
    "canonical",
    "mutate",
    "orchestrator",
    "sense",
    "llm_extract",
    "model_gateway",
]


@pytest.mark.parametrize("module", TOP_LEVEL_MODULES)
def test_module_importable(module):
    """Every top-level swarm module must import without raising."""
    sys.path.insert(0, str(SWARM_DIR))
    try:
        importlib.import_module(module)
    except ImportError as e:
        pytest.fail(f"{module} failed to import: {e}")


# ---------------------------------------------------------------------------
# 3. TTS fallback chain
# ---------------------------------------------------------------------------

def test_tts_unavailable_not_hard_crash(monkeypatch, tmp_path):
    """With no kokoro models and no CLI, synthesize_voice_logo must raise TTSUnavailable."""
    # Point kokoro dir at an empty temp dir (no model files).
    monkeypatch.setenv("HELIX_KOKORO_DIR", str(tmp_path))
    # Point CLI at a path that doesn't exist.
    monkeypatch.setenv("HELIX_TTS_CLI", str(tmp_path / "nonexistent-tts-bin"))

    sys.path.insert(0, str(SWARM_DIR))
    # Re-import with patched env so _kokoro_dir() and tts_status() pick up new values.
    import importlib
    import skills.sonic_brand.tts_provider as tts_mod
    importlib.reload(tts_mod)

    out = str(tmp_path / "out.wav")
    with pytest.raises(tts_mod.TTSUnavailable):
        tts_mod.synthesize_voice_logo("hello world", "af_heart", out)
