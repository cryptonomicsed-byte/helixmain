"""Mutation protocol: propose -> gate -> mint.

The card mutates with the company, but never as a wiki edit. Every change is
a structured proposal that passes a policy gate:

  1. PROPOSE  dna.propose_change(card_id, field, old, new, evidence, confidence)
  2. GATE     low-risk factual updates auto-apply; identity / voice / policy /
              competitor changes (and stale proposals) need human approval
  3. MINT     approved changes bump version, recompute the hash chain
              (previous_version + previous_hash), append a Changelog entry,
              mint a receipt, and re-emit CARD.md + compiled artifacts.

Usage:
  python3 mutate.py propose --card dna_XXXX --field operations.hours \\
      --old "Mon-Fri 7am-3pm" --new "Mon-Fri 7am-5pm" --evidence google_listing
  python3 mutate.py decide --proposal prop_XXXX --decision approve --by justin
"""
import argparse
import copy
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

SWARM = Path(__file__).parent
FOUNDRY = SWARM.parent
CARDS_DIR = FOUNDRY / "cards"
PROPOSALS_DIR = FOUNDRY / "proposals"
RECEIPTS_DIR = FOUNDRY / "receipts"
COMPILED_DIR = FOUNDRY / "compiled"
CLI = FOUNDRY / "compiler" / "dist" / "cli.js"

sys.path.insert(0, str(SWARM))
from orchestrator import acting_hash, canonical_hash, set_path, utcnow, validate  # noqa: E402
from model_gateway import AUTO_APPLY_CONFIDENCE, decide, Decision  # noqa: E402

# --- policy gate -----------------------------------------------------------
# Low-risk factual updates auto-apply. Identity / voice / policy / competitor
# changes need human approval. Unknown fields fail closed to approval.
_AUTO_PREFIXES = ("operations.", "offerings", "knowledge", "insights", "customers")
_APPROVAL_PREFIXES = ("identity", "voice", "policies", "competitors")


def gate(field: str, old, current) -> tuple[str, str]:
    """Rule tiers: the prior. Jev scores the final call (see gate_score)."""
    if old != current:
        return ("conflict",
                f"proposal is stale: expected {json.dumps(old)}, card has {json.dumps(current)}")
    if field.startswith(_AUTO_PREFIXES):
        return ("auto", f"low-risk factual update ({field})")
    if field.startswith(_APPROVAL_PREFIXES):
        return ("approval", f"{field.split('.')[0]} changes need human approval")
    return ("approval", f"unknown field '{field}' fails closed to approval")


def gate_score(field: str, old, new, evidence: str) -> Decision:
    """Jev decides whether the change may auto-apply (noul), with calibrated
    confidence. The rule tiers are the prior; the heuristic fallback defers
    to them so behavior without Jev is unchanged."""
    rule_auto = field.startswith(_AUTO_PREFIXES)

    def heuristic() -> Decision:
        return Decision("gate", rule_auto, confidence=0.8, provider="heuristic",
                        fallback_reason="rule tiers are the prior")

    return decide(
        "gate", "noul",
        "Should this business-card change auto-apply without human review? "
        "True only for low-risk factual updates (hours, channels, systems, "
        "offerings, knowledge, insights, customers) with supporting evidence. "
        "Identity, voice, policy and competitor changes always need a human.",
        {"true": "safe to auto-apply", "false": "needs human approval"},
        {"field": field, "old_value": old, "new_value": new,
         "evidence": evidence, "rule_tier": "auto" if rule_auto else "approval"},
        heuristic)


def verify_proposal(field: str, old, new, evidence: str, confidence: float) -> Decision:
    """Jev 'verify everything': is this proposal supported by the evidence?
    Score 0-1. Below 0.4 an auto-tier proposal is held for approval."""

    def heuristic() -> Decision:
        score = 0.3 if not evidence else min(0.9, 0.5 + 0.4 * (confidence or 0.5))
        return Decision("verify", round(score, 3), confidence=0.6,
                        provider="heuristic",
                        fallback_reason="evidence present + extractor confidence")

    return decide(
        "verify", "score",
        "Score how well the evidence supports applying this business-card "
        "change. 0 = contradicts or unsupported, 1 = directly supported.",
        ["unsupported", "weak", "supported", "strongly_supported"],
        {"field": field, "old_value": old, "new_value": new,
         "evidence": evidence, "extractor_confidence": confidence},
        heuristic)


def get_path(card: dict, path: str):
    node = card
    for p in path.split("."):
        if not isinstance(node, dict) or p not in node:
            return None
        node = node[p]
    return node


def load_card(card_id: str) -> tuple[dict, Path]:
    best = None
    for p in CARDS_DIR.glob("*.json"):
        try:
            card = json.loads(p.read_text())
        except Exception:
            continue
        if card.get("id") == card_id or card.get("id", "").startswith(card_id):
            if best is None or card.get("version", 0) > best[0].get("version", 0):
                best = (card, p)
    if best is None:
        raise FileNotFoundError(f"card {card_id} not found in {CARDS_DIR}")
    return best


def latest_card(org_id: str) -> dict:
    cands = []
    for p in CARDS_DIR.glob(f"*_{org_id}_v*.json"):
        card = json.loads(p.read_text())
        cands.append((card["version"], card))
    if not cands:
        raise FileNotFoundError(f"no cards for org {org_id}")
    cands.sort()
    return cands[-1][1]


def compiled_dir(card: dict) -> Path:
    return COMPILED_DIR / f"{card['id']}_v{card['version']}"


def load_changelog(card: dict) -> list[str]:
    cl_path = compiled_dir(card) / "CHANGELOG.json"
    if cl_path.exists():
        return json.loads(cl_path.read_text())
    return [f"**v{card['version']}** ({card['created_at']}): initial extraction"]


def mint_receipt(card: dict, proposal: dict, verdict: str, decided_by: str | None) -> dict:
    RECEIPTS_DIR.mkdir(exist_ok=True)
    rid = f"rcpt_{uuid.uuid4().hex[:8]}"
    receipt = {
        "id": rid,
        "organization_id": card["organization_id"],
        "agent_id": "agent_foundry",
        "task_id": proposal["id"],
        "action_id": "dna.propose_change",
        "policy_decision_id": f"pdec_{proposal['id']}",
        "worker_id": "worker_foundry",
        "tool": "dna.mutate",
        "verification_id": f"ver_{rid}",
        "result_summary": (f"card {card['id']} v{card['version']}: "
                           f"{proposal['field']} updated ({verdict})"),
        # The audit trail: which decider scored this mutation and how.
        "decision_trail": proposal.get("decision_trail", []),
        "verification": proposal.get("verification", {}),
        "cost_usd": round(sum(t.get("cost_usd", 0)
                              for t in proposal.get("decision_trail", [])), 6),
        "minted_at": utcnow(),
    }
    (RECEIPTS_DIR / f"{rid}.json").write_text(json.dumps(receipt, indent=2))
    return receipt


def apply_change(card: dict, proposal: dict, decided_by: str | None = None) -> dict:
    """Mint a new card version with the proposal applied. Returns result dict."""
    new = copy.deepcopy(card)
    set_path(new, proposal["field"], proposal["new"])
    # CARD.md chain convention: the card id is stable across versions;
    # previous_version is the prior version number, previous_hash the prior
    # full-card hash (bare hex). The compiler writes these to the frontmatter.
    new["previous_hash"] = card["hash"]
    new.pop("_previous_hash", None)
    new["previous_version"] = card["version"]
    new["version"] = card["version"] + 1
    new["created_at"] = utcnow()
    new["status"] = "approved" if decided_by else card.get("status", "draft")
    new["field_provenance"][proposal["field"]] = {
        "sources": [proposal["evidence"]] if proposal.get("evidence") else ["proposal"],
        "confidence": proposal.get("confidence", 0.7),
        "extracted_at": utcnow(),
        "extractor_agent": "mutator:dna.propose_change",
    }
    new["acting_hash"] = acting_hash(new)
    new["hash"] = canonical_hash(new)
    validate(new)

    org = new["organization_id"]
    path = CARDS_DIR / f"{new['id']}_{org}_v{new['version']}.json"
    path.write_text(json.dumps(new, indent=2))

    receipt = mint_receipt(new, proposal, "auto-applied" if not decided_by else "approved", decided_by)

    changelog = load_changelog(card)
    note = "auto-applied: low-risk factual update" if not decided_by else "approved by " + decided_by
    if proposal.get("status") == "conflict":
        note += "; rebased over current value"
    changelog.append(
        f"**v{new['version']}** ({new['created_at']}): {proposal['field']} changed "
        f"-- {note} (receipt {receipt['id']})")

    # re-emit CARD.md + compiled artifacts for the new version
    out = compiled_dir(new)
    cl_tmp = out / "CHANGELOG.src.json"
    out.mkdir(parents=True, exist_ok=True)
    cl_tmp.write_text(json.dumps(changelog))
    subprocess.run(["node", str(CLI), "--card", str(path), "--out", str(out),
                    "--changelog", str(cl_tmp)], check=True, capture_output=True)
    cl_tmp.unlink()

    return {"status": "applied", "card_id": new["id"], "version": new["version"],
            "card_path": str(path), "card_md": str(out / "CARD.md"),
            "receipt": receipt["id"], "changelog_entry": changelog[-1]}


def propose_change(card_id: str, field: str, old, new, evidence: str,
                   confidence: float = 0.7) -> dict:
    card, _ = load_card(card_id)
    current = get_path(card, field)
    verdict, reason = gate(field, old, current)

    # Jev-scored gate + verification. The calibrated confidence drives
    # auto-apply vs escalate — the property LLMs lack (overconfident,
    # inconsistent). Recorded on the proposal and the receipt: the audit
    # trail for why a mutation auto-applied.
    trail: list[dict] = []
    verification: dict = {}
    if verdict == "auto":
        g = gate_score(field, old, new, evidence)
        v = verify_proposal(field, old, new, evidence, confidence)
        trail = [g.trail(), v.trail()]
        verification = {"method": ("jev" if g.provider == "jev" or v.provider == "jev"
                                   else "heuristic"),
                        "gate_decision": g.decision, "gate_confidence": round(g.confidence, 3),
                        "support_score": v.decision,
                        "support_confidence": round(v.confidence, 3)}
        if not (g.decision is True and g.confidence >= AUTO_APPLY_CONFIDENCE):
            verdict = "approval"
            reason += (f"; Jev gate: auto-apply scored {g.confidence:.2f} "
                       f"(needs {AUTO_APPLY_CONFIDENCE})")
        elif float(v.decision) < 0.4:
            verdict = "approval"
            reason += f"; Jev verification: support score {v.decision:.2f} < 0.4"

    proposal = {
        "id": f"prop_{uuid.uuid4().hex[:8]}",
        "card_id": card["id"],
        "card_version": card["version"],
        "field": field,
        "old": old,
        "new": new,
        "evidence": evidence,
        "confidence": confidence,
        "verdict": verdict,
        "gate_reason": reason,
        "decision_trail": trail,
        "verification": verification,
        "status": "pending",
        "proposed_at": utcnow(),
    }
    PROPOSALS_DIR.mkdir(exist_ok=True)
    if verdict == "auto":
        result = apply_change(card, proposal)
        proposal["status"] = "applied"
        proposal.update({k: result[k] for k in ("card_id", "version", "receipt")})
        proposal["new_card_id"] = result["card_id"]
        (PROPOSALS_DIR / f"{proposal['id']}.json").write_text(json.dumps(proposal, indent=2))
        return {"proposal": proposal["id"], "gate": "auto", "reason": reason,
                "decision_trail": proposal["decision_trail"],
                "verification": proposal["verification"], **result}
    proposal["status"] = "awaiting_approval" if verdict == "approval" else "conflict"
    (PROPOSALS_DIR / f"{proposal['id']}.json").write_text(json.dumps(proposal, indent=2))
    return {"proposal": proposal["id"], "gate": verdict, "reason": reason,
            "status": proposal["status"],
            "decision_trail": proposal["decision_trail"],
            "verification": proposal["verification"]}


def decide_proposal(proposal_id: str, decision: str, decided_by: str) -> dict:
    p = PROPOSALS_DIR / f"{proposal_id}.json"
    if not p.exists():
        # allow prefix match
        cands = list(PROPOSALS_DIR.glob(f"{proposal_id}*.json"))
        if not cands:
            raise FileNotFoundError(f"proposal {proposal_id} not found")
        p = cands[0]
    proposal = json.loads(p.read_text())
    if proposal["status"] not in ("awaiting_approval", "conflict"):
        return {"proposal": proposal["id"], "status": proposal["status"],
                "note": "already decided; not re-applied"}
    if decision == "deny":
        proposal["status"] = "denied"
        proposal["decided_by"] = decided_by
        proposal["decided_at"] = utcnow()
        p.write_text(json.dumps(proposal, indent=2))
        return {"proposal": proposal["id"], "status": "denied"}
    if decision != "approve":
        raise ValueError("decision must be approve|deny")
    card, _ = load_card(proposal["card_id"])
    proposal["decided_by"] = decided_by
    proposal["decided_at"] = utcnow()
    result = apply_change(card, proposal, decided_by=decided_by)
    proposal["status"] = "applied"
    proposal["new_card_id"] = result["card_id"]
    p.write_text(json.dumps(proposal, indent=2))
    return {"proposal": proposal["id"], "gate": "approved", **result}


def main():
    ap = argparse.ArgumentParser(description="DNA card mutation protocol")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("propose")
    pr.add_argument("--card", required=True)
    pr.add_argument("--field", required=True)
    pr.add_argument("--old", required=True)
    pr.add_argument("--new", required=True)
    pr.add_argument("--evidence", default="manual")
    pr.add_argument("--confidence", type=float, default=0.7)
    de = sub.add_parser("decide")
    de.add_argument("--proposal", required=True)
    de.add_argument("--decision", required=True, choices=["approve", "deny"])
    de.add_argument("--by", default="operator")
    args = ap.parse_args()
    if args.cmd == "propose":
        try:
            old = json.loads(args.old)
        except Exception:
            old = args.old
        try:
            new = json.loads(args.new)
        except Exception:
            new = args.new
        print(json.dumps(propose_change(args.card, args.field, old, new,
                                        args.evidence, args.confidence), indent=2))
    else:
        print(json.dumps(decide_proposal(args.proposal, args.decision, args.by), indent=2))


if __name__ == "__main__":
    main()
