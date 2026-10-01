"""Helix DNA Foundry — extractor swarm base classes.

Every extractor is a sandboxed agent instance with:
  - a persistent profile (goals, skills, memory namespace) as JSON in swarm/profiles/
  - file-backed working memory under swarm/memory/<namespace>/
  - a ReAct-style loop: THINK -> ACT (call a skill) -> OBSERVE -> record provenance
  - A2A handoffs: JSON messages on a per-run bus (swarm/a2a/<run_id>.jsonl)

Skills are drop-in modules in swarm/skills/ exposing a SKILL descriptor.
Hot-swap = add/remove a file; the registry picks it up on the next run.
(The WASM sandbox for these plugins is a documented future, not built here.)
"""

from __future__ import annotations

import importlib
import json
import pkgutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PROFILES_DIR = ROOT / "profiles"
MEMORY_DIR = ROOT / "memory"
A2A_DIR = ROOT / "a2a"
SKILLS_DIR = ROOT / "skills"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Finding:
    """One extracted fact with provenance. Everything the swarm believes
    about the business travels in these."""
    field: str            # card field path, e.g. "identity.name" or "policies"
    value: Any
    confidence: float     # 0..1
    sources: list[str]    # URLs / documents the fact came from
    extractor_agent: str = ""

    def provenance(self) -> dict:
        return {
            "sources": self.sources,
            "confidence": self.confidence,
            "extracted_at": utcnow(),
            "extractor_agent": self.extractor_agent,
        }


class MemoryNamespace:
    """Persistent, file-backed working memory for one agent profile.
    This is runtime memory — a cache, never the canonical tenant memory."""

    def __init__(self, namespace: str):
        self.path = MEMORY_DIR / namespace
        self.path.mkdir(parents=True, exist_ok=True)

    def read(self, key: str, default: Any = None) -> Any:
        p = self.path / f"{key}.json"
        if not p.exists():
            return default
        return json.loads(p.read_text())

    def write(self, key: str, value: Any) -> None:
        (self.path / f"{key}.json").write_text(json.dumps(value, indent=2))

    def append(self, key: str, value: Any) -> None:
        items = self.read(key, []) or []
        items.append(value)
        self.write(key, items)


class A2ABus:
    """Agent-to-agent message bus. JSON-lines log per run; messages are
    addressed envelopes: {id, from, to, type, payload, ts}."""

    def __init__(self, run_id: str):
        A2A_DIR.mkdir(parents=True, exist_ok=True)
        self.log_path = A2A_DIR / f"{run_id}.jsonl"

    def send(self, sender: str, to: str, msg_type: str, payload: dict) -> dict:
        msg = {
            "id": f"msg_{uuid.uuid4().hex[:8]}",
            "from": sender,
            "to": to,
            "type": msg_type,
            "payload": payload,
            "ts": utcnow(),
        }
        with open(self.log_path, "a") as f:
            f.write(json.dumps(msg) + "\n")
        return msg

    def inbox(self, agent: str) -> list[dict]:
        if not self.log_path.exists():
            return []
        out = []
        for line in self.log_path.read_text().splitlines():
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("to") in (agent, "broadcast"):
                out.append(msg)
        return out


class SkillRegistry:
    """Auto-discovers skill modules in swarm/skills/. Each module exposes
    SKILL = {name, version, description, fields, run(context) -> list[Finding]}."""

    def __init__(self):
        self.skills: dict[str, dict] = {}
        self._load()

    def _load(self):
        import skills as _pkg  # noqa: F401  (swarm/ is on sys.path via orchestrator)
        for mod in pkgutil.iter_modules([str(SKILLS_DIR)]):
            if mod.name.startswith("_"):
                continue
            try:
                module = importlib.import_module(f"skills.{mod.name}")
                desc = getattr(module, "SKILL", None)
                if desc and "run" in desc and "name" in desc:
                    self.skills[desc["name"]] = desc
            except Exception as e:  # a broken plugin must not kill the swarm
                print(f"[skills] skipping {mod.name}: {e}")

    def get(self, name: str) -> dict | None:
        return self.skills.get(name)

    def list(self) -> list[str]:
        return sorted(self.skills)


class ExtractorAgent:
    """Base class. Subclasses declare a profile file and implement run()."""

    profile_name: str = "base"

    def __init__(self, bus: A2ABus, registry: SkillRegistry):
        profile_path = PROFILES_DIR / f"{self.profile_name}.json"
        if not profile_path.exists():
            raise FileNotFoundError(f"profile missing: {profile_path}")
        self.profile = json.loads(profile_path.read_text())
        self.name: str = self.profile["agent"]
        self.memory = MemoryNamespace(self.profile["memory_namespace"])
        self.bus = bus
        self.registry = registry
        self.trace: list[dict] = []  # ReAct trace: think/act/observe steps

    # -- ReAct primitives -------------------------------------------------
    def think(self, thought: str) -> None:
        self.trace.append({"t": "think", "thought": thought, "ts": utcnow()})

    def act(self, skill_name: str, context: dict) -> list[Finding]:
        skill = self.registry.get(skill_name)
        if not skill:
            self.trace.append({"t": "act", "skill": skill_name, "error": "skill not installed"})
            return []
        self.trace.append({"t": "act", "skill": skill_name})
        try:
            findings = skill["run"](context) or []
        except Exception as e:
            self.trace.append({"t": "observe", "skill": skill_name, "error": str(e)})
            return []
        for f in findings:
            f.extractor_agent = self.name
        self.trace.append({
            "t": "observe", "skill": skill_name,
            "findings": len(findings),
            "fields": sorted({f.field for f in findings}),
        })
        self.memory.append("last_findings", [f.__dict__ for f in findings])
        return findings

    def send(self, to: str, msg_type: str, payload: dict) -> dict:
        return self.bus.send(self.name, to, msg_type, payload)

    def finding(self, field: str, value: Any, confidence: float,
                sources: list[str]) -> Finding:
        """Build a Finding stamped with this agent's identity (for findings
        minted directly in run(), not via a skill)."""
        return Finding(field, value, confidence, sources,
                       extractor_agent=self.name)

    def run(self, ctx: dict) -> list[Finding]:
        raise NotImplementedError
