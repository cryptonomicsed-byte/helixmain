#!/usr/bin/env python3
"""Issue, list, and revoke OPERATOR keys for the HelixMain platform API.

An operator key is the ONE deliberate cross-company credential. It grants exactly
one extra power over a company key: sight across companies — `GET /companies`
returns every provisioned company (the dashboard switcher). It is NOT a tenant:
any route that needs a real company still requires that company's own key or a
passkey session, so an operator key cannot read or mutate another company's card,
credits, or CRM.

Keys live in a single 0600 file (`/etc/helix/operator-keys.json`), whose JSON is
`{"keys": ["hk_op_…", …]}`. The API reloads that file at most every 10s, so a new
key becomes live without a restart.

Usage:
    python3 issue-operator-key.py                 # mint a key, print it ONCE
    python3 issue-operator-key.py --list          # show key fingerprints
    python3 issue-operator-key.py --revoke <key>  # remove a key
"""
import argparse
import hashlib
import json
import os
import secrets
import sys

PATH = os.environ.get("HELIX_OPERATOR_KEYS", "/etc/helix/operator-keys.json")


def load():
    try:
        with open(PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return []
    except Exception as e:
        sys.exit(f"refusing to touch {PATH}: {e}")
    keys = raw if isinstance(raw, list) else raw.get("keys", [])
    if not isinstance(keys, list):
        sys.exit(f"{PATH} is not a key list")
    return [k for k in keys if isinstance(k, str) and k]


def save(keys):
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"keys": keys}, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, PATH)  # atomic


def fp(key):
    return "hk_op_…" + hashlib.sha256(key.encode()).hexdigest()[:8]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="list key fingerprints")
    ap.add_argument("--revoke", metavar="KEY", help="revoke a full key string")
    args = ap.parse_args()

    keys = load()

    if args.list:
        if not keys:
            print(f"no operator keys configured ({PATH})")
        for k in keys:
            print(fp(k))
        return

    if args.revoke:
        if args.revoke not in keys:
            sys.exit("that key is not present")
        keys = [k for k in keys if k != args.revoke]
        save(keys)
        print(f"revoked {fp(args.revoke)} — {len(keys)} operator key(s) remain")
        return

    key = "hk_op_" + secrets.token_hex(24)
    keys.append(key)
    save(keys)
    print("Operator key issued (shown ONCE — store it now):")
    print()
    print("  " + key)
    print()
    print(f"file: {PATH} (0600) — {len(keys)} operator key(s) total")
    print("live within ~10s (the API caches keys for 10s); no restart needed.")
    print("Use: -H 'x-api-key: <the key>'  → GET /api/companies returns all companies.")


if __name__ == "__main__":
    main()
