"""Canonical JSON for the card hash — shared by the swarm and all skills.

The card hash must be byte-identical whether computed in Python (swarm,
skills) or TypeScript (compiler). JS numbers are all doubles, so the
canonical form normalizes integral floats to ints: Python's json.dumps
writes 4.0 as "4.0" while JSON.stringify writes "4". Normalizing first
keeps both sides in agreement.
"""
from __future__ import annotations

import hashlib
import json


def _canon_numbers(v):
    if isinstance(v, dict):
        return {k: _canon_numbers(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_canon_numbers(x) for x in v]
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _prune(v):
    """Drop empty arrays/objects as object values: `"threats": []` is the
    same as a missing `threats` for identity purposes. Applied bottom-up so
    `{"swot": {"threats": []}}` prunes to `{}` and then away entirely."""
    if isinstance(v, (list, tuple)):
        return [_prune(x) for x in v]
    if isinstance(v, dict):
        out = {}
        for k in sorted(v):
            pv = _prune(v[k])
            if pv == [] or pv == {}:
                continue
            out[k] = pv
        return out
    return v


def canonical_json(card: dict) -> str:
    body = _canon_numbers(
        {k: v for k, v in card.items() if k != "hash" and not k.startswith("_")}
    )
    return json.dumps(_prune(body), sort_keys=True, separators=(",", ":"))


def canonical_hash(card: dict) -> str:
    return hashlib.sha256(canonical_json(card).encode()).hexdigest()


#: Card-level keys that form the acting (quotable) layer of business-card/0.1.
#: Must match ACTING_KEYS in the TypeScript compiler's card-md.ts exactly.
ACTING_KEYS = (
    "identity",
    "voice",
    "offerings",
    "operations",
    "policies",
    "handoff",
    "knowledge",
)


def acting_fields(card: dict) -> dict:
    return {k: card[k] for k in ACTING_KEYS if k in card}


def acting_hash(card: dict) -> str:
    """SHA-256 of the canonical JSON of the acting layer only."""
    return hashlib.sha256(canonical_json(acting_fields(card)).encode()).hexdigest()
