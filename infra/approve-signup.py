#!/usr/bin/env python3
"""Review signup requests that arrived through the landing page's "Create account".

WHY THIS EXISTS
The landing page collects a business name + email and nothing else. It does NOT
create a company, a card, credits, or an enrollment link — passkeys.ts is explicit
that enrollment is bootstrapped by an operator-issued one-time token and that
"there is no permanent open enrollment door". An unauthenticated route that minted
accounts would be exactly that door (and would repeat the initAccount
money-printer mistake). So the request lands on disk and a human decides.

    python3 approve-signup.py                         # list pending
    python3 approve-signup.py --all                   # list everything
    python3 approve-signup.py --approve <id> --company <slug>
    python3 approve-signup.py --reject  <id> --note "out of area"

`--approve` does NOT onboard anyone. It marks the request decided and then runs
`issue-enroll-token.py` for the company you name — which requires that company to
already be onboarded (a card on disk). If it isn't, onboard first:

    ./helix-onboard.sh <slug> ...
    python3 approve-signup.py --approve <id> --company <slug>

The enroll URL is printed ONCE; the token is stored hashed, so it cannot be shown
again — issue another if it is lost.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

SIGNUP_DIR = os.environ.get("HELIX_SIGNUP_DIR", "/etc/helix/signups")
COMPANIES_ROOT = os.environ.get("HELIX_CARD_ROOT", "/etc/helix/companies")
HERE = os.path.dirname(os.path.abspath(__file__))


def load_all() -> list[dict]:
    out: list[dict] = []
    if not os.path.isdir(SIGNUP_DIR):
        return out
    for name in sorted(os.listdir(SIGNUP_DIR)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(SIGNUP_DIR, name), encoding="utf-8") as fh:
                rec = json.load(fh)
            rec.setdefault("status", "pending")
            out.append(rec)
        except (OSError, ValueError):
            continue
    out.sort(key=lambda r: r.get("requestedAt", ""), reverse=True)
    return out


def find(records: list[dict], key: str) -> dict | None:
    for r in records:
        if r.get("id") == key or (r.get("email") or "").lower() == key.lower():
            return r
    return None


def write(rec: dict) -> None:
    path = os.path.join(SIGNUP_DIR, f"{rec['id']}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2)
    os.chmod(path, 0o600)


def show(records: list[dict]) -> int:
    if not records:
        print(f"no signup requests under {SIGNUP_DIR}")
        return 0
    print(f"{'id':10s} {'status':9s} {'business':28s} {'email':30s} requested")
    print("-" * 96)
    for r in records:
        print(
            f"{r.get('id',''):10s} {r.get('status',''):9s} "
            f"{(r.get('business') or '')[:28]:28s} {(r.get('email') or '')[:30]:30s} "
            f"{r.get('requestedAt','')[:19]}"
        )
    pending = [r for r in records if r.get("status") == "pending"]
    print(f"\n{len(pending)} pending.")
    return 0


def decide(args) -> int:
    records = load_all()
    key = args.approve or args.reject
    rec = find(records, key)
    if not rec:
        print(f"ERROR: no request matching {key!r}", file=sys.stderr)
        return 1
    if rec.get("status") != "pending":
        print(f"ERROR: request {rec['id']} is already {rec['status']}", file=sys.stderr)
        return 1

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    if args.reject:
        rec["status"] = "rejected"
        rec["decidedAt"] = now
        rec["note"] = args.note or ""
        write(rec)
        print(f"rejected {rec['id']} ({rec.get('business')})")
        return 0

    company = args.company
    card = os.path.join(COMPANIES_ROOT, company, "card.json")
    if not os.path.isfile(card):
        print(
            f"ERROR: {company} is not onboarded yet (no {card}).\n"
            f"Onboard it first, then re-run:\n"
            f"    ./helix-onboard.sh {company} ...",
            file=sys.stderr,
        )
        return 1

    rec["status"] = "approved"
    rec["decidedAt"] = now
    rec["company"] = company
    write(rec)

    print(f"approved {rec['id']} ({rec.get('business')}) -> company {company}\n")
    # One source of truth for token minting: reuse the existing tool.
    return subprocess.call(
        [sys.executable, os.path.join(HERE, "issue-enroll-token.py"), company, "--hours", str(args.hours)]
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Review landing-page signup requests.")
    ap.add_argument("--list", action="store_true", help="list pending requests (default)")
    ap.add_argument("--all", action="store_true", help="list every request, decided or not")
    ap.add_argument("--approve", metavar="ID_OR_EMAIL", help="approve a request")
    ap.add_argument("--reject", metavar="ID_OR_EMAIL", help="reject a request")
    ap.add_argument("--company", help="onboarded company slug to grant (with --approve)")
    ap.add_argument("--note", default="", help="reason (with --reject)")
    ap.add_argument("--hours", type=float, default=24.0, help="enrollment link lifetime (default 24)")
    args = ap.parse_args()

    if args.approve or args.reject:
        if args.approve and not args.company:
            ap.error("--approve needs --company <slug>")
        return decide(args)

    records = load_all()
    if not args.all:
        records = [r for r in records if r.get("status") == "pending"]
    return show(records)


if __name__ == "__main__":
    raise SystemExit(main())
