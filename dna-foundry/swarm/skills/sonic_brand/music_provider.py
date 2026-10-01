"""Music-model provider for the sonic logo + UI sounds — slot wired, stubbed.

Thin wrapper over the model_gateway music slot (FAL_API_KEY / HELIX_MUSIC_MODEL).
Without a key, generate_* raises MusicProviderStubbed and the skill keeps the
staged brief + generation prompt. Same key-passthrough pattern as Sacred Core's
fal image/video provider (keys.fal || '').
"""
from __future__ import annotations

import sys
from pathlib import Path

_SWARM = Path(__file__).resolve().parent.parent.parent
if str(_SWARM) not in sys.path:
    sys.path.insert(0, str(_SWARM))

from model_gateway import (  # noqa: E402
    MusicProviderStubbed, generate_music, music_status)

__all__ = ["MusicProviderStubbed", "generate_music", "music_status"]
