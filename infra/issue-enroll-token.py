#!/usr/bin/env python3
"""Issue (or inspect) a one-time passkey enrollment link for a company.

The dashboard login is a passkey now, so a device has to be enrolled once. That
is bootstrapped by a single-use, expiring token — there is no permanently open
enrollment door (the same discipline the gatekeeper's /gk/setup uses).

Run on the host that holds /etc/helix/companies:

    python3 issue-enroll-token.py demo-barber            # 24h default
    python3 issue-enroll-token.py demo-barber --hours 2
    python3 issue-enroll-token.py demo-barber --show     # print without rotating

Prints the enroll URL once. The token is stored HASHED (sha256) at
<company>/enroll-token.json, so the plaintext is unrecoverable afterwards — if you
lose it, issue another.

NOTE: this is the operator's break-glass for enrollment. It requires shell access
to the host, which is strictly stronger than the dashboard session it creates.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import secrets
import sys

COMPANIES_ROOT = os.environ.get("HELIX_CARD_ROOT", "/etc/helix/companies")
BASE_URL = os.environ.get("HELIX_BASE_URL", "https://helixmain.duckdns.org")


def token_path(company: str) -> str:
    return os.path.join(COMPANIES_ROOT, company, "enroll-token.json")


def main() -> int:
    ap = argparse.ArgumentParser(description="Issue a one-time passkey enrollment link.")
    ap.add_argument("company", help="provisioned company slug (the dashboard company id)")
    ap.add_argument("--hours", type=float, default=24.0, help="token lifetime (default 24)")
    ap.add_argument("--show", action="store_true", help="report status without issuing a new token")
    args = ap.parse_args()

    company = args.company
    # PROVISIONED, not onboarded. The passkey store keys off
    # listProvisionedCompanies, so a company with api-keys.json can sign in whether
    # or not it has a card — and the admin account is DELIBERATELY card-less (it is
    # not a business, so there is nothing to extract). Requiring card.json made the
    # admin unreachable: make-admin.py --status points at this script, and this
    # script refused the very account it was pointed at.
    keys = os.path.join(COMPANIES_ROOT, company, "api-keys.json")
    if not os.path.isfile(keys):
        print(f"ERROR: {company} is not a provisioned company (no {keys}). "
              f"Sign up first, or check the spelling.", file=sys.stderr)
        return 1
    if not os.path.isfile(os.path.join(COMPANIES_ROOT, company, "card.json")):
        print(f"NOTE: {company} has no card yet — it can sign in and enroll, it just "
              f"has nothing to show. Expected for an account like helix-admin.")

    p = token_path(company)
    if args.show:
        if not os.path.isfile(p):
            print(f"no enrollment token for {company}")
            return 0
        with open(p, encoding="utf-8") as fh:
            f = json.load(fh)
        exp = datetime.datetime.fromtimestamp(f["exp"] / 1000, datetime.timezone.utc)
        left = exp - datetime.datetime.now(datetime.timezone.utc)
        state = "EXPIRED" if left.total_seconds() < 0 else f"{left.total_seconds() / 3600:.1f}h left"
        print(f"{company}: token issued {f.get('created_at')} · expires {exp.isoformat()} ({state})")
        print("(plaintext is not recoverable — use --show only to check validity)")
        return 0

    token = secrets.token_hex(24)
    record = {
        "token_sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
        "exp": int((datetime.datetime.now(datetime.timezone.utc)
                    + datetime.timedelta(hours=args.hours)).timestamp() * 1000),
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    os.chmod(p, 0o600)

    print(f"company:  {company}")
    print(f"expires:  {args.hours}h")
    print(f"enroll:   {BASE_URL}/dashboard/?enroll={token}")
    print("\nOpen that URL on the device that should hold the passkey, ONCE.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
