#!/usr/bin/env python3
"""migrate-accounts.py — give every existing company an account that owns it.

Before the account layer, account == company == the one card. This walks every
company dir and ensures ONE thing: an account record whose `owned` contains that
company. For the historical 1:1 accounts that is simply account(id) -> [id], so
no data moves, no key rotates, nothing is re-provisioned — it only ADDS the
ownership edge that was implicit before.

Idempotent: re-running appends nothing that is already there and never clobbers
an account's other fields.

    python3 migrate-accounts.py            # migrate every company
    python3 migrate-accounts.py --dry-run  # report, change nothing
    python3 migrate-accounts.py <id> ...   # only these companies

Run ON THE VPS.
"""
from __future__ import annotations

import json
import os
import sys

COMPANIES = os.environ.get("HELIX_COMPANIES", "/etc/helix/companies")
ACCOUNTS = os.environ.get("HELIX_ACCOUNTS_DIR", "/etc/helix/accounts")


def load_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def business_name(company: str) -> str:
    d = os.path.join(COMPANIES, company)
    card = load_json(os.path.join(d, "card.json"))
    name = ((card.get("identity") or {}).get("name")) if isinstance(card, dict) else None
    if name:
        return str(name)
    acct = load_json(os.path.join(d, "account.json"))
    return str(acct.get("business") or company)


def account_path(account_id: str) -> str:
    return os.path.join(ACCOUNTS, f"{account_id}.json")


def migrate(company: str, dry: bool) -> str:
    """Ensure account(company).owned contains company. Returns a status line."""
    ap = account_path(company)
    existing = load_json(ap)
    owned = existing.get("owned")
    if not isinstance(owned, list):
        owned = []
    if company in owned:
        return f"{company}: already owns itself (account present)"

    if dry:
        return f"{company}: WOULD create account with owned=[{company}]"

    rec = {
        "id": company,
        "business": existing.get("business") or business_name(company),
        "email": existing.get("email"),
        "website": existing.get("website"),
        "provider": existing.get("provider"),
        "googleSub": existing.get("googleSub"),
        "createdAt": existing.get("createdAt") or _now(),
        "status": existing.get("status") or "active",
        "owned": owned + [company],
    }
    os.makedirs(ACCOUNTS, exist_ok=True)
    os.chmod(ACCOUNTS, 0o700)
    with open(ap, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2)
    os.chmod(ap, 0o600)
    return f"{company}: account created, owned=[{company}]"


def _now() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    wanted = [a for a in argv if not a.startswith("-")]

    if wanted:
        companies = wanted
    else:
        try:
            companies = sorted(
                e for e in os.listdir(COMPANIES)
                if os.path.isdir(os.path.join(COMPANIES, e))
            )
        except FileNotFoundError:
            print(f"no companies dir at {COMPANIES}", file=sys.stderr)
            return 1

    print(f"migrating {len(companies)} company(ies) -> {ACCOUNTS}"
          + (" (dry-run)" if dry else ""))
    changed = 0
    for c in companies:
        line = migrate(c, dry)
        print(f"  {line}")
        if "already owns" not in line:
            changed += 1
    print(f"done — {changed} changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
