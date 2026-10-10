#!/usr/bin/env python3
"""Idempotently provision HelixMain's Paperclip projects.

WHY THIS EXISTS
The bootstrap that first created these projects was NOT idempotent. It ran twice
on 2026-10-08 (17:42:52 and 17:44:48) and Paperclip de-duplicated the *name* by
suffixing — leaving `INTERNAL 2` and `CLIENT-santinos-pizza 2` behind. Nothing
referenced them (taskCount 0, no issue.projectId), so no work was lost, but a
third run would have minted ` 3`.

`paperclipai project create` has no idempotency check of its own, so the guard has
to live here: LIST first, create only what is missing, match on the shortname
(urlKey) Paperclip derives from the name.

USAGE
    provision-paperclip-projects.py --company <companyId>
    provision-paperclip-projects.py --company <companyId> --client santinos-pizza
    provision-paperclip-projects.py --company <companyId> --dry-run

Always ensures the INTERNAL project; one CLIENT-<slug> project per --client.
Safe to re-run: a second run creates nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

CLI = os.environ.get(
    "PAPERCLIP_BIN", "/root/.paperclip/cli/current/node_modules/.bin/paperclipai"
)
NODE_BIN = os.environ.get("PAPERCLIP_NODE_BIN", "/opt/node24/bin")


def run(args: list[str]) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PATH"] = NODE_BIN + os.pathsep + env.get("PATH", "")
    return subprocess.run([CLI, *args], capture_output=True, text=True, env=env)


def slug(name: str) -> str:
    """Mirror Paperclip's urlKey derivation from a project name."""
    out = "".join(c.lower() if c.isalnum() else "-" for c in name)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def list_projects(company: str) -> list[dict]:
    p = run(["project", "list", "-C", company, "--json"])
    if p.returncode != 0:
        sys.exit(f"project list failed: {p.stderr.strip() or p.stdout.strip()}")
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        sys.exit(f"project list returned non-JSON: {p.stdout[:200]}")
    rows = d if isinstance(d, list) else d.get("projects", d.get("data", []))
    return [r for r in rows if isinstance(r, dict)]


def main() -> int:
    ap = argparse.ArgumentParser(description="Idempotently provision Paperclip projects.")
    ap.add_argument("--company", required=True, help="Paperclip company id")
    ap.add_argument("--client", action="append", default=[],
                    help="client slug; repeatable. Adds CLIENT-<slug>.")
    ap.add_argument("--dry-run", action="store_true", help="report, create nothing")
    args = ap.parse_args()

    existing = list_projects(args.company)
    have = {str(p.get("urlKey") or slug(p.get("name", ""))).lower() for p in existing}
    print(f"company {args.company}: {len(existing)} project(s) present")
    for k in sorted(have):
        print(f"    = {k}")

    wanted: list[tuple[str, str]] = [
        ("INTERNAL", "Company operations, infrastructure, product development."),
    ]
    for c in args.client:
        wanted.append((f"CLIENT-{c}", f"Client engagement workspace for {c}."))

    created = 0
    for name, desc in wanted:
        key = slug(name)
        if key in have:
            print(f"  = {name}  (already present — left alone)")
            continue
        if args.dry_run:
            print(f"  + {name}  (would create)")
            continue
        p = run(["project", "create", "-C", args.company, "--name", name, "--description", desc])
        if p.returncode != 0:
            sys.exit(f"create {name} failed: {p.stderr.strip() or p.stdout.strip()}")
        created += 1
        print(f"  + {name}  (created)")

    print(f"done: {created} created, {len(wanted) - created} already present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
