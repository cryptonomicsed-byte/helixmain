#!/usr/bin/env python3
"""Append a hash-chained entry to a company's API changelog ledger.

There is ONE changelog per company and it is the API's ledger:

    /etc/helix/companies/<slug>/changelog.json

`dna-foundry/api/src/services/changelog.ts` owns its format and verifies it.
Card mutations made *through the API* (the dashboard's propose -> confirm flow)
are appended there by the API itself. Card mutations made *outside* the API --
`helix-onboard.sh create|update` -- are appended here, so the company's history
is one continuous chain no matter which surface changed the card.

The hash MUST be byte-identical to changelog.ts's `hashEntry`, or the chain the
API verifies would break on the next append:

    entryHash = sha256(f"{previousHash}|{version}|{timestamp}|{','.join(sorted(fields))}")
    previousHash = previous entry's entryHash, or GENESIS (64 zeros)
    version      = len(entries) + 1

Timestamps are written in the same shape JS `Date.prototype.toISOString()`
produces (`...T%H:%M:%S.mmmZ`) so the dashboard can render them with `new Date`.

The timestamp string is hashed exactly as stored and re-hashed exactly as stored
by verifyChain, so the format is not load-bearing for the chain -- only for
display. It is written ISO anyway.

Usage:
  append-ledger.py <company_dir> --card-id <id> --mutation created \
      [--company-id <slug>] [--author onboarding] [--note "..."] [--fields "a,b"]

Exit codes: 0 on append; 1 on bad input; 2 on an unreadable/invalid ledger.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys

GENESIS_HASH = "0" * 64
VALID_MUTATIONS = {"created", "owner-confirmed", "inferred", "promoted", "restored"}


def hash_entry(previous_hash: str, version: int, ts: str, fields: list[str]) -> str:
    content = f"{previous_hash}|{version}|{ts}|{','.join(sorted(fields))}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def iso_now() -> str:
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def load_ledger(path: str, company_id: str) -> dict:
    if not os.path.exists(path):
        return {"cardId": "", "companyId": company_id, "entries": [], "headHash": GENESIS_HASH}
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    try:
        log = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: {path} is not valid JSON: {exc}") from None
    if not isinstance(log.get("entries"), list):
        log["entries"] = []
    if not log.get("headHash"):
        log["headHash"] = (
            log["entries"][-1]["entryHash"] if log["entries"] else GENESIS_HASH
        )
    if not log.get("companyId"):
        log["companyId"] = company_id
    return log


def derive_fields(company_dir: str, explicit: str) -> list[str]:
    """Explicit wins; else a created card reports its top-level sections."""
    if explicit:
        return [f.strip() for f in explicit.split(",") if f.strip()]
    card_path = os.path.join(company_dir, "card.json")
    try:
        with open(card_path, "r", encoding="utf-8") as fh:
            card = json.load(fh)
        keys = [
            k for k in card.keys()
            if k not in ("hash", "acting_hash", "previous_hash")
        ]
        return sorted(keys) or ["*"]
    except (OSError, json.JSONDecodeError):
        return ["*"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Append an entry to a company's card changelog ledger.")
    ap.add_argument("company_dir")
    ap.add_argument("--card-id", dest="card_id", default="")
    ap.add_argument("--company-id", dest="company_id", default="")
    ap.add_argument("--mutation", default="owner-confirmed", choices=sorted(VALID_MUTATIONS))
    ap.add_argument("--author", default="onboarding")
    ap.add_argument("--note", default="")
    ap.add_argument("--fields", default="")
    args = ap.parse_args()

    company_dir = args.company_dir.rstrip("/")
    if not os.path.isdir(company_dir):
        print(f"ERROR: not a directory: {company_dir}", file=sys.stderr)
        return 1

    company_id = args.company_id or os.path.basename(company_dir)
    card_id = args.card_id
    if not card_id:
        card_path = os.path.join(company_dir, "card.json")
        try:
            with open(card_path, "r", encoding="utf-8") as fh:
                card_id = json.load(fh).get("id", "")
        except (OSError, json.JSONDecodeError):
            card_id = ""

    ledger_path = os.path.join(company_dir, "changelog.json")
    log = load_ledger(ledger_path, company_id)

    fields = derive_fields(company_dir, args.fields)
    if not fields:
        fields = ["*"]

    version = len(log["entries"]) + 1
    ts = iso_now()
    previous_hash = log.get("headHash") or GENESIS_HASH
    entry_hash = hash_entry(previous_hash, version, ts, fields)

    entry: dict = {
        "version": version,
        "timestamp": ts,
        "fieldsChanged": sorted(fields),
        "mutationType": args.mutation,
        "previousHash": previous_hash,
        "entryHash": entry_hash,
        "author": args.author,
    }
    if args.note:
        entry["note"] = args.note

    log["entries"].append(entry)
    log["headHash"] = entry_hash
    if card_id:
        log["cardId"] = card_id
    log["companyId"] = company_id

    tmp = ledger_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(log, fh, indent=2)
    os.replace(tmp, ledger_path)

    print(f"    ledger: v{version} appended ({args.mutation}) entryHash={entry_hash[:16]}...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
