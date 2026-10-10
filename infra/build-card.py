#!/usr/bin/env python3
"""Author a Business DNA card (card.json) for helix-onboard.

This is the ONLY thing onboarding owns: turning operator input into the card
object. Everything downstream — CARD.md, system-prompt.md, policy-seed.json,
tool-allowlist.json, rag-manifest.json, openshell-policy.yaml, hugo/ — is
derived by the real compiler (dna-foundry/compiler). No hashing happens here:
the compiler computes `hash` and `acting_hash` and `helix-onboard.sh` folds the
real values back in. That is the point — there is exactly one compiler.

Shape is the canonical business-card/0.1 model the compiler round-trips and the
API consumes: voice.tone is an array, operations.channels is a string list,
knowledge entries are objects. Empty values are OMITTED, never written as "":
the emitter drops falsy sections, so an empty string in the card would make
CARD.md fail to verify.

Usage:
  build-card.py --id demo --org org_demo --name "Demo Cafe" [--existing-file c.json] ...

Every --field that is the empty string means "not supplied". On create that
means the default; on update it means "keep what the existing card has".
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys

PIPELINE_STAGES = ["new", "contacted", "qualified", "converted", "lost"]
DEFAULT_TONE = ["warm", "helpful", "professional"]
KNOWN_TYPES = {"restaurant", "service", "retail"}


def split_items(value: str, sep: str) -> list[str]:
    return [p.strip() for p in value.split(sep) if p.strip()]


def parse_policies(value: str) -> list[dict]:
    """`topic: rule | topic: rule` -> [{topic, rule}] (topic spaces -> _)."""
    out = []
    for pol in split_items(value, "|"):
        topic, _, rule = pol.partition(":")
        topic = topic.strip().replace(" ", "_")
        if not topic:
            continue
        out.append({"topic": topic, "rule": rule.strip()})
    return out


def parse_socials(value: str) -> dict[str, str]:
    """`instagram:handle|facebook:handle` -> {instagram: handle}"""
    out: dict[str, str] = {}
    for item in split_items(value, "|"):
        platform, _, handle = item.partition(":")
        platform, handle = platform.strip(), handle.strip()
        if platform and handle:
            out[platform] = handle
    return out


def parse_specials(value: str) -> list[dict]:
    """`name:description:price:valid_from:valid_to|...` -> [special]"""
    out = []
    for item in split_items(value, "|"):
        parts = (item.split(":") + ["", "", "", ""])[:5]
        name, desc, price, vfrom, vto = (p.strip() for p in parts)
        if not name:
            continue
        spec: dict = {"name": name}
        if desc:
            spec["description"] = desc
        if price:
            try:
                spec["price"] = float(price) if "." in price else int(price)
            except ValueError:
                spec["price"] = price
        if vfrom:
            spec["valid_from"] = vfrom
        if vto:
            spec["valid_to"] = vto
        out.append(spec)
    return out


def parse_offerings(value: str, keep: list[dict] | None) -> list[dict]:
    """`Item1, Item2` -> canonical offerings. No input -> default single Service."""
    names = split_items(value, ",")
    if not names:
        if keep:
            return keep
        names = ["Service"]
    return [
        {"name": n, "kind": "service", "orderable": True, "price": None, "confidence": 0.6}
        for n in names
    ]


def build(args: argparse.Namespace) -> dict:
    existing: dict = {}
    if args.existing_file:
        with open(args.existing_file) as fh:
            existing = json.load(fh)

    # The card NESTS its fields: identity.{name,type,location,socials,
    # elevator_pitch}, operations.{hours,response_sla,channels,pipeline_stages},
    # voice.{tone,personality,donts}. Reading them off the TOP level (which this
    # did) silently DROPPED every field the operator didn't re-type on update —
    # a lookup that missed fell straight through to the create-time default.
    # Reach into the sub-object that actually holds the value.
    ident = existing.get("identity") or {}
    oper = existing.get("operations") or {}
    voice_ex = existing.get("voice") or {}

    def pick(supplied: str, mapping: dict, key: str, default=None):
        """Supplied wins; else the existing card's nested value; else default."""
        if supplied:
            return supplied
        if mapping.get(key) is not None:
            return mapping[key]
        return default

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    is_update = bool(existing)
    version = (existing.get("version") or 0) + 1 if is_update else 1

    name = pick(args.name, ident, "name") or args.id
    pitch = pick(args.pitch, ident, "elevator_pitch") or ""

    identity: dict = {"name": name}
    # Omit, never emit "": prune() only drops empty arrays/objects, so an empty
    # string would sit in the card while the emitter skips the falsy bullet —
    # the round-trip would then fail verification.
    if pitch:
        identity["elevator_pitch"] = pitch
    biz_type = args.type or ident.get("type") or "service"
    identity["type"] = biz_type
    for key, value in (("location", pick(args.location, ident, "location")),
                       ("phone", pick(args.phone, ident, "phone")),
                       ("review_url", pick(args.review_url, ident, "review_url"))):
        if value:
            identity[key] = value
    socials = parse_socials(args.socials) or ident.get("socials") or {}
    if socials:
        identity["socials"] = socials

    voice: dict = {"tone": voice_ex.get("tone") or DEFAULT_TONE}
    voice["personality"] = pick(args.pitch, voice_ex, "personality",
                                f"Friendly and knowledgeable representative for {name}.")
    voice["donts"] = voice_ex.get("donts") or [
        "Use cold, corporate or impersonal language.",
        "Rush callers or make them feel unwelcome.",
    ]

    operations: dict = {}
    hours = pick(args.hours, oper, "hours")
    if hours:
        operations["hours"] = hours
    operations["channels"] = oper.get("channels") or ["phone"]
    operations["pipeline_stages"] = oper.get("pipeline_stages") or PIPELINE_STAGES
    sla = pick(args.sla, oper, "response_sla")
    if sla:
        operations["response_sla"] = sla

    policies = parse_policies(args.policies) or existing.get("policies") or [{
        "topic": "refunds",
        "rule": f"Not satisfied? Call {identity.get('phone', 'us')} and speak with the manager.",
    }]
    policy_donts = split_items(args.policy_donts, "|") or existing.get("policy_donts") or []

    knowledge = existing.get("knowledge") or [{
        "title": f"About {name}",
        "ref": identity.get("location", ""),
        "kind": "general",
        "chunks": 1,
    }]

    card: dict = {
        "id": args.id,
        "version": version,
        "organization_id": args.org or existing.get("organization_id") or "",
        "status": existing.get("status") or "draft",
        "created_at": existing.get("created_at") or now,
        "identity": identity,
        "voice": voice,
        "offerings": parse_offerings(args.offerings, existing.get("offerings")),
        "operations": operations,
        "policies": policies,
        "knowledge": knowledge,
    }
    specials = parse_specials(args.specials) or existing.get("specials") or []
    if specials:
        card["specials"] = specials
    if policy_donts:
        card["policy_donts"] = policy_donts
    # previous_version must be PRESENT (null on v1): the parser materialises it as
    # null from frontmatter, and prune() only drops empty arrays/objects — so an
    # absent key hashing differently from an explicit null would break verify.
    card["previous_version"] = (existing.get("version") or 1) if is_update else None
    # Chain the hash as well. A v2 whose previous_hash reads "none" is not a
    # chain at all — the whole point of hashing the card is that each version
    # commits to the one before it. existing['hash'] is the compiler's REAL
    # folded hash of the prior version (stored bare-hex in card.json).
    prior_hash = str(existing.get("hash") or "").replace("sha256:", "").strip()
    if is_update and prior_hash:
        card["previous_hash"] = prior_hash
    if is_update and existing.get("created_at"):
        card["created_at"] = existing["created_at"]
    # Preserve appendix material (strategy/customers/competitors/insights/visual)
    # and provenance across an update — onboarding never authors those.
    for key in ("strategy", "customers", "competitors", "insights", "visual",
                "handoff", "field_provenance", "appendix"):
        if key in existing:
            card[key] = existing[key]
    return card


def main() -> int:
    ap = argparse.ArgumentParser(description="Author a Business DNA card JSON.")
    ap.add_argument("--id", required=True)
    ap.add_argument("--org", default="")
    ap.add_argument("--name", default="")
    ap.add_argument("--type", default="")
    ap.add_argument("--location", default="")
    ap.add_argument("--phone", default="")
    ap.add_argument("--hours", default="")
    ap.add_argument("--pitch", default="")
    ap.add_argument("--offerings", default="")
    ap.add_argument("--policies", default="")
    ap.add_argument("--review-url", dest="review_url", default="")
    ap.add_argument("--socials", default="")
    ap.add_argument("--specials", default="")
    ap.add_argument("--sla", default="")
    ap.add_argument("--policy-donts", dest="policy_donts", default="")
    ap.add_argument("--existing-file", dest="existing_file", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    card = build(args)
    text = json.dumps(card, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
