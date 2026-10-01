#!/usr/bin/env python3
"""MCP tool handlers for the DNA Foundry.

Usage: python3 handlers.py <tool> '<json args>'
Implements the tools declared in mcp/tools.json by driving the swarm
orchestrator and the TypeScript compiler. Pure glue — no extraction logic here.
"""
import glob
import json
import subprocess
import sys
from pathlib import Path

FOUNDRY = Path(__file__).resolve().parents[1]
CARD_DIRS = [FOUNDRY / "cards", FOUNDRY / "api" / "data" / "cards"]
COMPILED_DIR = FOUNDRY / "compiled"
COMPILER_CLI = FOUNDRY / "compiler" / "dist" / "cli.js"


def find_card(card_id: str) -> Path | None:
    for d in CARD_DIRS:
        hits = sorted(d.glob(f"{card_id}*.json")) if d.exists() else []
        if hits:
            return hits[-1]
    return None


def tool_extract(args: dict) -> dict:
    url = args["url"]
    org = args.get("organization_id", "org_demo0001")
    out = CARD_DIRS[0]
    out.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [sys.executable, str(FOUNDRY / "swarm" / "orchestrator.py"),
         "extract", "--url", url, "--org", org, "--out", str(out)],
        capture_output=True, text=True, cwd=str(FOUNDRY))
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr[-2000:]}
    card_path = r.stdout.strip().splitlines()[-1]
    card = json.loads(Path(card_path).read_text())
    return {"ok": True, "card_id": card["id"], "version": card["version"],
            "card_path": card_path,
            "fields": sorted(card["field_provenance"].keys())}


def tool_get(args: dict) -> dict:
    p = find_card(args["card_id"])
    if not p:
        return {"ok": False, "error": f"card not found: {args['card_id']}"}
    return {"ok": True, "card": json.loads(p.read_text())}


def tool_compile(args: dict) -> dict:
    p = find_card(args["card_id"])
    if not p:
        return {"ok": False, "error": f"card not found: {args['card_id']}"}
    card = json.loads(p.read_text())
    out = COMPILED_DIR / f"{card['id']}_v{card['version']}"
    r = subprocess.run(["node", str(COMPILER_CLI), "--card", str(p), "--out", str(out)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr[-2000:]}
    return {"ok": True, "card_id": card["id"], "version": card["version"],
            "out_dir": str(out),
            "artifacts": ["CARD.md", "CHANGELOG.json", "system-prompt.md",
                          "policy-seed.json", "tool-allowlist.json",
                          "rag-manifest.json", "dna-fields-used.json"],
            "card_md": str(out / "CARD.md")}


def tool_diff(args: dict) -> dict:
    pa, pb = find_card(args["card_a"]), find_card(args["card_b"])
    if not pa or not pb:
        return {"ok": False, "error": "one or both cards not found"}
    r = subprocess.run(["node", str(COMPILER_CLI), "--card", str(pa),
                        "--diff", str(pb)], capture_output=True, text=True)
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr[-2000:]}
    return {"ok": True, "diff": json.loads(r.stdout)}


def _swarm(cmd: list[str]) -> dict:
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(FOUNDRY))
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr[-2000:] or r.stdout[-2000:]}
    try:
        return {"ok": True, **json.loads(r.stdout)}
    except Exception:
        return {"ok": True, "output": r.stdout[-2000:]}


def tool_propose_change(args: dict) -> dict:
    return _swarm([sys.executable, str(FOUNDRY / "swarm" / "mutate.py"), "propose",
                   "--card", args["card_id"], "--field", args["field"],
                   "--old", json.dumps(args["old"]), "--new", json.dumps(args["new"]),
                   "--evidence", args.get("evidence", "mcp"),
                   "--confidence", str(args.get("confidence", 0.7))])


def tool_decide_proposal(args: dict) -> dict:
    return _swarm([sys.executable, str(FOUNDRY / "swarm" / "mutate.py"), "decide",
                   "--proposal", args["proposal_id"], "--decision", args["decision"],
                   "--by", args.get("decided_by", "operator")])


def tool_sense(args: dict) -> dict:
    cmd = [sys.executable, str(FOUNDRY / "swarm" / "sense.py"),
           "--org", args["organization_id"]]
    if args.get("force"):
        cmd.append("--force")
    return _swarm(cmd)


HANDLERS = {"dna.extract": tool_extract, "dna.get": tool_get,
            "dna.compile": tool_compile, "dna.diff": tool_diff,
            "dna.propose_change": tool_propose_change,
            "dna.decide_proposal": tool_decide_proposal,
            "dna.sense": tool_sense}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in HANDLERS:
        print(json.dumps({"ok": False,
                          "error": f"usage: handlers.py <{'|'.join(HANDLERS)}> '<json>'"}))
        sys.exit(2)
    args = json.loads(sys.argv[2])
    print(json.dumps(HANDLERS[sys.argv[1]](args), indent=2))


if __name__ == "__main__":
    main()
