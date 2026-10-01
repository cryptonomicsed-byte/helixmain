#!/usr/bin/env python3
"""Helix DNA Foundry — extraction orchestrator.

Runs the extractor swarm (website -> documents, reviews, competitor),
merges findings into a Business DNA card, validates it against
agent-os/contracts/dna-card.json, and writes a versioned, content-addressed card.

Usage:
  python3 orchestrator.py extract --url <url> --org org_demo0001 [--out DIR]

Optional model gateway (real LLM extraction instead of heuristics):
  HELIX_MODEL_GATEWAY_URL=https://...  (OpenAI-compatible /v1/chat/completions)

The heuristic path needs no API keys.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import jsonschema

SWARM = Path(__file__).resolve().parent
sys.path.insert(0, str(SWARM))

from agents.base import A2ABus, Finding, SkillRegistry, utcnow  # noqa: E402
from agents.website import WebsiteExtractor  # noqa: E402
from agents.documents import DocumentsExtractor  # noqa: E402
from agents.reviews import ReviewsExtractor  # noqa: E402
from agents.competitor import CompetitorExtractor  # noqa: E402
from agents.strategy import StrategyExtractor  # noqa: E402
from agents.visual import VisualExtractor  # noqa: E402
from agents.crawl import crawl_plan  # noqa: E402

CONTRACT = SWARM.parent.parent / "agent-os" / "contracts" / "dna-card.json"
CARDS_DIR = SWARM.parent / "cards"

# field path -> merge strategy
_SCALAR_FIELDS = {
    "identity.name", "identity.tagline", "identity.location", "identity.mission",
    "identity.founded", "identity.elevator_pitch",
    "operations.hours", "operations.systems",
    "voice.tone", "voice.sample_phrases", "voice.donts", "voice.personality",
    "voice.description", "identity.values", "operations.channels",
    "visual.primary_color", "visual.secondary_color", "visual.font_pairing",
    "visual.design_system", "visual.image_style",
    "strategy.positioning",
}
_ARRAY_FIELDS = {"offerings", "policies", "competitors", "insights", "knowledge",
                 "strategy.key_messaging", "customers.personas"}
# dict-valued fields: recursive merge — leaf scalars confidence-wins,
# leaf arrays union, sub-objects recurse. Provenance at the object path.
_OBJECT_FIELDS = {"strategy.swot", "voice.sonic"}


def empty_card(org_id: str, version: int, previous: str | None) -> dict:
    return {
        "id": f"dna_{uuid.uuid4().hex[:8]}",
        "organization_id": org_id,
        "version": version,
        "previous_version": previous,
        "status": "draft",
        "created_at": utcnow(),
        "identity": {"name": ""},
        "field_provenance": {},
    }


def set_path(card: dict, path: str, value):
    parts = path.split(".")
    node = card
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = value


def _merge_object_node(node: dict, path: str, value: dict, f: Finding, prov: dict) -> None:
    """Recursive object merge for _OBJECT_FIELDS."""
    for k, v in value.items():
        sub = f"{path}.{k}"
        if isinstance(v, dict):
            child = node.setdefault(k, {})
            _merge_object_node(child, sub, v, f, prov)
        elif isinstance(v, list):
            arr = node.setdefault(k, [])
            for item in v:
                key = json.dumps(item, sort_keys=True)
                if key not in {json.dumps(x, sort_keys=True) for x in arr}:
                    arr.append(item)
        elif v is not None:
            cur = prov.get(sub)
            if cur is None or f.confidence > cur["confidence"]:
                node[k] = v
                prov[sub] = f.provenance()


def _merge_personas(card: dict, f: Finding) -> None:
    """Personas merge by name: pain_points union, other fields confidence-wins."""
    card.setdefault("customers", {})
    arr = card["customers"].setdefault("personas", [])
    val = f.value if isinstance(f.value, list) else [f.value]
    prov = card["field_provenance"]
    for p in val:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        name = p["name"]
        existing = next((x for x in arr if x.get("name") == name), None)
        if existing is None:
            arr.append(p)
        else:
            for k, v in p.items():
                if k == "pain_points" and isinstance(v, list):
                    ep = existing.setdefault("pain_points", [])
                    for item in v:
                        if item not in ep:
                            ep.append(item)
                elif v and (not existing.get(k) or f.confidence > prov.get(
                        f"customers.personas.{name}.{k}", {}).get("confidence", 0)):
                    existing[k] = v
    p = prov.get("customers.personas", {"sources": [], "confidence": 0,
                                        "extracted_at": utcnow(),
                                        "extractor_agent": f.extractor_agent})
    p["sources"] = sorted(set(p["sources"]) | set(f.sources))
    p["confidence"] = max(p["confidence"], f.confidence)
    p["extracted_at"] = utcnow()
    prov["customers.personas"] = p


def merge_findings(card: dict, findings: list[Finding]) -> None:
    prov = card["field_provenance"]
    for f in findings:
        if f.field in _SCALAR_FIELDS:
            cur = prov.get(f.field)
            if cur is None or f.confidence > cur["confidence"]:
                set_path(card, f.field, f.value)
                prov[f.field] = f.provenance()
        elif f.field in _OBJECT_FIELDS:
            node: dict = card
            for part in f.field.split("."):
                node = node.setdefault(part, {})
            _merge_object_node(node, f.field, f.value or {}, f, prov)
            p = prov.get(f.field, {"sources": [], "confidence": 0,
                                   "extracted_at": utcnow(),
                                   "extractor_agent": f.extractor_agent})
            p["sources"] = sorted(set(p["sources"]) | set(f.sources))
            p["confidence"] = max(p["confidence"], f.confidence)
            p["extracted_at"] = utcnow()
            prov[f.field] = p
        elif f.field == "customers.personas":
            _merge_personas(card, f)
        elif f.field in _ARRAY_FIELDS:
            parts = f.field.split(".")
            node = card
            for p in parts[:-1]:
                node = node.setdefault(p, {})
            arr = node.setdefault(parts[-1], [])
            vals = f.value if isinstance(f.value, list) else [f.value]
            seen = {json.dumps(v, sort_keys=True) for v in arr}
            for v in vals:
                key = json.dumps(v, sort_keys=True)
                if key not in seen:
                    arr.append(v)
                    seen.add(key)
            # array-level provenance: union of sources, max confidence
            p = prov.get(f.field, {"sources": [], "confidence": 0,
                                   "extracted_at": utcnow(), "extractor_agent": f.extractor_agent})
            p["sources"] = sorted(set(p["sources"]) | set(f.sources))
            p["confidence"] = max(p["confidence"], f.confidence)
            p["extracted_at"] = utcnow()
            prov[f.field] = p
        else:
            print(f"[orchestrator] WARN: unknown field '{f.field}' from {f.extractor_agent}; dropped")


def canonical_hash(card: dict) -> str:
    from canonical import canonical_hash as _ch
    return _ch(card)


def acting_hash(card: dict) -> str:
    from canonical import acting_hash as _ah
    return _ah(card)


def validate(card: dict) -> None:
    schema = json.loads(CONTRACT.read_text())
    jsonschema.validate(card, schema)


def previous_card(org_id: str, out_dir: Path) -> dict | None:
    import re
    cands = []
    for p in out_dir.glob(f"*_{org_id}_v*.json"):
        m = re.search(r"_v(\d+)\.json$", p.name)
        if m:
            cands.append((int(m.group(1)), p))
    if not cands:
        return None
    cands.sort()
    return json.loads(cands[-1][1].read_text())


def cmd_extract(args) -> Path:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    prev = previous_card(args.org, out_dir)
    version = (prev["version"] + 1) if prev else 1
    prev_id = prev["id"] if prev else None

    run_id = f"run_{uuid.uuid4().hex[:8]}"
    bus = A2ABus(run_id)
    registry = SkillRegistry()
    print(f"[orchestrator] run {run_id} — skills: {', '.join(registry.list())}")

    card = empty_card(args.org, version, prev_id)
    # keep the same card id across versions of one org's lineage? No:
    # each version is content-addressed; lineage links via previous_version.

    ctx = {"url": args.url, "run_id": run_id}
    order = [WebsiteExtractor, DocumentsExtractor, ReviewsExtractor, StrategyExtractor, VisualExtractor, CompetitorExtractor]
    all_findings: list[Finding] = []
    for cls in order:
        agent = cls(bus, registry)
        print(f"[orchestrator] running {agent.name} "
              f"(skills: {', '.join(agent.profile.get('skills', [])) or 'none'})")
        findings = agent.run(ctx)
        all_findings.extend(findings)
        print(f"[orchestrator] {agent.name}: {len(findings)} findings, "
              f"{len(agent.trace)} react steps")
        if agent.name == "extractor:website":
            ctx["homepage_url"] = agent.memory.read("homepage_url")

    merge_findings(card, all_findings)
    # Competitor fallback (Justin's rule): on-site evidence first; when the
    # site names no competitors, infer the obvious category players. Every
    # inferred competitor is marked as such — never presented as the
    # business's claim.
    if not card.get("competitors"):
        from skills import competitor_inference
        inferred = competitor_inference.run({"card": card})
        if inferred:
            print(f"[orchestrator] no on-site competitors — "
                  f"inferred {len(inferred)} from category")
            merge_findings(card, inferred)
    if not card["identity"]["name"]:
        card["identity"]["name"] = "Unknown Business"
        prov = {"sources": [args.url], "confidence": 0.1,
                "extracted_at": utcnow(), "extractor_agent": "orchestrator"}
        card["field_provenance"]["identity.name"] = prov

    card["acting_hash"] = acting_hash(card)
    card["hash"] = canonical_hash(card)
    validate(card)

    path = out_dir / f"{card['id']}_{args.org}_v{version}.json"
    path.write_text(json.dumps(card, indent=2))
    trace_path = out_dir / f"{card['id']}_trace.json"
    print(f"[orchestrator] card v{version} validated OK -> {path}")
    print(f"[orchestrator] {len(all_findings)} findings, "
          f"{len(card['field_provenance'])} provenance entries")
    return path


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract")
    ex.add_argument("--url", required=True)
    ex.add_argument("--org", default="org_demo0001")
    ex.add_argument("--out", default=str(SWARM.parent / "cards"))
    args = ap.parse_args()
    if args.cmd == "extract":
        path = cmd_extract(args)
        print(path)


if __name__ == "__main__":
    main()
