#!/usr/bin/env python3
"""Scan the files git tracks for things that must never be committed: private keys, Nostr
secret keys, HELIX bearer tokens, and API-key-shaped strings. Public TEST keys that the
conformance suites deliberately publish are allowlisted by path."""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = subprocess.check_output(["git", "-C", ROOT, "rev-parse", "--show-toplevel"], text=True).strip()
ALLOW = (
    "agent-os/kernel/tests/fixtures/sid-0.2/",   # the public test issuer and agent keys of the sid/0.2 conformance suite
    "agent-os/contracts/conformance/",
    "agent-os/gateway/internal/qr/testdata/",    # vendored conformance vectors (signatures, no secrets)
    "agent-os/plugins/dist/",                    # compiled components (binary)
)
PATTERNS = {
    "a PEM private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----"),
    "a Nostr secret key (nsec)": re.compile(r"\bnsec1[02-9ac-hj-np-z]{50,}\b"),
    "a HELIX bearer token": re.compile(r"\bhxg_[A-Za-z0-9_-]{43}\b"),
    "an AWS access key id": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "a GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "a Slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    "an Anthropic or OpenAI style key": re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b"),
}

files = subprocess.check_output(["git", "-C", REPO, "ls-files", "-z"], text=True).split("\0")
hits = []
for rel in filter(None, files):
    if rel.startswith(ALLOW) or any(a in rel for a in ALLOW):
        continue
    path = os.path.join(REPO, rel)
    try:
        if os.path.getsize(path) > 2_000_000:
            continue
        text = open(path, encoding="utf-8").read()
    except (UnicodeDecodeError, OSError):
        continue
    for label, rx in PATTERNS.items():
        for m in rx.finditer(text):
            hits.append(f"{rel}: {label}")
            break
if hits:
    print("secrets found in tracked files:\n  " + "\n  ".join(hits), file=sys.stderr)
    sys.exit(1)
print(f"scanned {len(files)} tracked files: no private keys, tokens or API keys")
