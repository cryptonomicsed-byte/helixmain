#!/usr/bin/env python3
"""make-admin.py — designate the ONE admin account, and prove the lock holds.

The admin account gets unlimited credits and sight of platform-wide data. Three
things keep that from being a liability:

  1. It is an allowlist on disk (/etc/helix/admin.json, 0600, root, NOT in git).
     Nothing a client sends can grant it.
  2. The API only honours it for a PASSKEY SESSION — `requireAdmin` refuses any
     request whose credential is a per-company API key, even the right company's.
  3. If the file is missing or unreadable the list is empty, so the admin
     subsystem fails CLOSED rather than open.

    make-admin.py --status              who is admin now, and are they reachable
    make-admin.py --status --company X  check one candidate
    make-admin.py <company-id>          designate (writes the allowlist)
    make-admin.py --revoke              remove every admin

    make-admin.py --session [--ttl 600] mint a short-lived admin SESSION cookie

`--session` is not a back door bolted onto the API: it uses the same HMAC signer
the passkey login uses (`services/session.ts`) with the same secret file, and it
needs root to read that secret. It exists so the admin routes can be tested from a
shell at all — the alternative would be a bypass in the application code, which is
exactly what we are trying to avoid.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
from typing import NoReturn

ADMIN_FILE = os.environ.get("HELIX_ADMIN_FILE", "/etc/helix/admin.json")
COMPANIES = os.environ.get("HELIX_COMPANIES_DIR", "/etc/helix/companies")
SECRET_FILE = os.environ.get("HELIX_SESSION_SECRET_FILE", "/etc/helix/session-secret")
SESSION_COOKIE = "helix_session"


def die(msg: str) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def read_admin() -> dict:
    try:
        d = json.load(open(ADMIN_FILE))
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        die(f"{ADMIN_FILE} is not valid JSON ({e}) — refusing to guess an allowlist")


def write_admin(d: dict) -> None:
    os.makedirs(os.path.dirname(ADMIN_FILE), exist_ok=True)
    tmp = f"{ADMIN_FILE}.tmp-{secrets.token_hex(4)}"
    with open(tmp, "w") as fh:
        json.dump(d, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ADMIN_FILE)
    os.chmod(ADMIN_FILE, 0o600)
    print(f"  wrote {ADMIN_FILE} (0600)")


def describe(cid: str) -> None:
    d = os.path.join(COMPANIES, cid)
    exists = os.path.isdir(d)
    provisioned = os.path.isfile(os.path.join(d, "api-keys.json"))
    passkeys = os.path.join(d, "passkeys.json")
    has_passkey = False
    count = 0
    if os.path.isfile(passkeys):
        try:
            pk = json.load(open(passkeys))
            items = pk if isinstance(pk, list) else pk.get("credentials", pk)
            count = len(items) if hasattr(items, "__len__") else 0
            has_passkey = count > 0
        except (json.JSONDecodeError, OSError):
            pass
    print(f"  {cid}")
    print(f"    directory     : {'yes' if exists else 'MISSING'}")
    print(f"    provisioned   : {'yes' if provisioned else 'NO (no api-keys.json)'}")
    print(f"    passkeys      : {count} enrolled" if has_passkey
          else "    passkeys      : NONE — you could not sign in as this account")
    if not has_passkey:
        print(f"    -> enroll a device: python3 infra/issue-enroll-token.py {cid}")
        print("       then open the printed /dashboard/?enroll=<token> URL ONCE")


def cmd_status(company: str | None) -> None:
    d = read_admin()
    companies = d.get("companies") or []
    print(f"admin file: {ADMIN_FILE}")
    print(f"admins    : {companies if companies else '(none — the admin subsystem is OFF)'}")
    for c in (companies or ([company] if company else [])):
        describe(c)


def cmd_designate(company: str) -> None:
    if not os.path.isdir(os.path.join(COMPANIES, company)):
        die(f"no company '{company}' under {COMPANIES} — onboard it first")
    if not os.path.isfile(os.path.join(COMPANIES, company, "api-keys.json")):
        die(f"'{company}' is not provisioned — sign it up (or onboard) first")

    d = read_admin()
    # ONE admin. The feature is "the operator's account", not "an admin role a
    # team accumulates" — every extra entry is another unlimited account to secure.
    d["companies"] = [company]
    d["note"] = ("The single account with unlimited credits and platform-wide sight. "
                 "Honoured ONLY for a passkey session (see requireAdmin). Not in git.")
    write_admin(d)
    print()
    describe(company)


def cmd_revoke() -> None:
    d = read_admin()
    d["companies"] = []
    write_admin(d)
    print("  every admin removed — admin routes now refuse everyone (fail closed)")


def sign_session(company: str, role: str, ttl_s: int) -> str:
    """Mint `base64url(json).hmac` exactly as services/session.ts does."""
    try:
        raw = open(SECRET_FILE).read().strip()
    except FileNotFoundError:
        die(f"no session secret at {SECRET_FILE} — start the API once to mint it")
    secret = bytes.fromhex(raw) if len(raw) >= 64 else None
    if secret is None:
        die(f"{SECRET_FILE} is not a hex secret")
    payload = json.dumps(
        {"company": company, "role": role, "exp": int(__import__("time").time() * 1000) + ttl_s * 1000},
        separators=(",", ":"),
    )
    b64 = base64.urlsafe_b64encode(payload.encode()).rstrip(b"=").decode()
    mac = hmac.new(secret, b64.encode(), hashlib.sha256).digest()
    return f"{b64}.{base64.urlsafe_b64encode(mac).rstrip(b'=').decode()}"


def cmd_session(ttl: int) -> None:
    d = read_admin()
    companies = d.get("companies") or []
    if not companies:
        die("no admin designated — run make-admin.py <company-id> first")
    company = companies[0]
    token = sign_session(company, "owner", ttl)
    print(f"admin session for '{company}' (ttl {ttl}s)\n")
    print(f"  cookie: {SESSION_COOKIE}={token}\n")
    print("  use it as a header (no browser needed):")
    print(f"    curl -H 'Cookie: {SESSION_COOKIE}={token}' <url>\n")
    print("  this is a real signed session, not a bypass: it expires, and it is only")
    print("  admin because the allowlist above names the account.")


def main() -> None:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("company", nargs="?", help="company id to designate as admin")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--company", dest="check", help="company to describe with --status")
    ap.add_argument("--revoke", action="store_true")
    ap.add_argument("--session", action="store_true")
    ap.add_argument("--ttl", type=int, default=600)
    a = ap.parse_args()

    if os.geteuid() != 0:
        die("run as root — the allowlist and session secret are root-only")
    if a.revoke:
        return cmd_revoke()
    if a.session:
        return cmd_session(a.ttl)
    if a.status or not a.company:
        return cmd_status(a.check)
    return cmd_designate(a.company)


if __name__ == "__main__":
    main()
