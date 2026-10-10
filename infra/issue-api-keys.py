#!/usr/bin/env python3
"""Issue per-company API keys for onboarded companies that lack them.

Mirrors services/apiKeys.ts (hk_ + 24 random bytes hex). Idempotent — a company
that already has keys keeps them, because re-onboarding must not rotate a live
credential out from under a deployed agent.

Writes 0600 <HELIX_COMPANIES>/<id>/api-keys.json. Prints the PATH, never the keys
(secrets do not belong in chat or a terminal scrollback — `cat` the file).
"""
import json
import os
import secrets

ROOT = os.environ.get("HELIX_CARD_ROOT", "/etc/helix/companies")


def new_key() -> str:
    return "hk_" + secrets.token_hex(24)


issued, kept = [], []
for name in sorted(os.listdir(ROOT)):
    d = os.path.join(ROOT, name)
    if not os.path.isdir(d):
        continue
    if not os.path.exists(os.path.join(d, "card.json")):
        continue  # not an onboarded company
    p = os.path.join(d, "api-keys.json")
    if os.path.exists(p):
        try:
            k = json.load(open(p))
            if k.get("company") and k.get("owner"):
                kept.append(name)
                continue
        except Exception:
            pass
    keys = {"company": new_key(), "owner": new_key()}
    with open(p, "w") as f:
        json.dump(keys, f, indent=2)
    os.chmod(p, 0o600)
    issued.append(name)

print(f"issued keys : {issued if issued else '(none)'}")
print(f"kept existing: {kept if kept else '(none)'}")
for name in issued:
    print(f"  {name}  ->  {ROOT}/{name}/api-keys.json  (0600)")
