#!/usr/bin/env python3
"""provision-voice.py — give a company its voice endpoint, idempotently.

A company can answer a call only when four things exist on the VPS:

    <slug>/identity                sk / pk / npub   (the /call page reads the npub)
    <slug>/env                     the agent's runtime env (LLM key, relay, card, seckey)
    agent-voice-<slug>.service     the systemd unit
    the unit                      enabled and started

helix-onboard.sh create writes all four inline. The self-serve API path
(dna-foundry/api/src/services/signup.ts::provisionCompany) writes only
<slug>/seckey, so every company it creates is invisible to the page and can
never ring — that is the "voice not enabled for this business" bug. This is
that missing step, pulled out of the shell so BOTH paths call ONE implementation.

One npub per business: an existing identity is reused; a company that has only a
seckey has its pubkey/npub derived from it (never a second identity minted).

    provision-voice.py <slug>            ensure the endpoint (idempotent)
    provision-voice.py --check <slug>    report what is present, change nothing
    provision-voice.py --force <slug>    rewrite env + unit, restart

Run it ON THE VPS (it needs systemctl and /opt/minipae).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import NoReturn

COMPANIES = os.environ.get("HELIX_COMPANIES", "/etc/helix/companies")
RELAY = os.environ.get("HELIX_VOICE_RELAY", "wss://omokoda.duckdns.org:3443")
SETTINGS = os.environ.get("HELIX_SETTINGS", "/etc/helix/settings.json")
STATE_ROOT = os.environ.get("HELIX_STATE_ROOT", "/var/lib/helix")
SYSTEMD_DIR = "/etc/systemd/system"
VENV_PY = "/opt/agent-voice-venv/bin/python"
AGENT_DIR = "/opt/agent-voice"


def die(msg: str, code: int = 1) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


# ── crypto: secp256k1 pubkey (minipae) + npub (bech32), same as helix-onboard ──

def pubkey_hex(sk_hex: str) -> str:
    for p in ("/opt/minipae", "/opt/agent-phone"):
        if p not in sys.path:
            sys.path.insert(0, p)
    import minipae  # noqa: E402
    pk_int = minipae.pubkey_from_secret(int(sk_hex, 16))
    pk = pk_int if isinstance(pk_int, bytes) else pk_int.to_bytes(32, "big")
    return pk.hex()


CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]


def _polymod(v: list[int]) -> int:
    chk = 1
    for b in v:
        t = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ b
        for i in range(5):
            chk ^= GEN[i] if ((t >> i) & 1) else 0
    return chk


def _hrp_expand(h: str) -> list[int]:
    return [ord(c) >> 5 for c in h] + [0] + [ord(c) & 31 for c in h]


def _conv(data: list[int], fb: int, tb: int) -> list[int]:
    acc = bits = 0
    ret: list[int] = []
    for v in data:
        acc = ((acc << fb) | v) & 0xFFFFFFFF
        bits += fb
        while bits >= tb:
            bits -= tb
            ret.append((acc >> bits) & ((1 << tb) - 1))
    if bits:
        ret.append((acc << (tb - bits)) & ((1 << tb) - 1))
    return ret


def npub_of(pk_hex: str) -> str:
    d5 = _conv(list(bytes.fromhex(pk_hex)), 8, 5)
    pm = _polymod(_hrp_expand("npub") + d5 + [0] * 6) ^ 1
    ck = [(pm >> (5 * (5 - i))) & 31 for i in range(6)]
    return "npub1" + "".join(CHARSET[x] for x in d5 + ck)


# ── inputs ────────────────────────────────────────────────────────────────────

def company_dir(slug: str) -> str:
    return os.path.join(COMPANIES, slug)


def load_seckey(slug: str) -> str:
    """The company's channel key. Prefer `identity` line 1, fall back to `seckey`."""
    d = company_dir(slug)
    for name in ("identity", "seckey"):
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            continue
        first = (open(p).read().splitlines() or [""])[0].strip()
        if re.fullmatch(r"[0-9a-f]{64}", first):
            return first
    die(f"{slug}: no usable identity/seckey in {d}")
    raise AssertionError  # unreachable


def existing_npub(slug: str) -> str:
    p = os.path.join(company_dir(slug), "identity")
    if os.path.isfile(p):
        for line in open(p):
            if line.strip().startswith("npub1"):
                return line.strip()
    return ""


def llm_key() -> str:
    """The platform's LLM key — whatever Settings last saved. Never hardcoded."""
    env_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    if env_key:
        return env_key
    try:
        s = json.load(open(SETTINGS))
        keys = s.get("keys") or {}
        provider = s.get("provider") or "deepseek"
        key = keys.get(provider) or keys.get("deepseek") or ""
        if key:
            return key
    except Exception:
        pass
    die(f"no LLM key: neither DEEPSEEK_API_KEY/LLM_API_KEY nor {SETTINGS} keys.* set")


def has_card(slug: str) -> bool:
    d = company_dir(slug)
    return os.path.isfile(os.path.join(d, "card.json")) or os.path.isfile(os.path.join(d, "CARD.md"))


# ── writers ──────────────────────────────────────────────────────────────────

def write_identity(slug: str, sk: str, pk: str, npub: str) -> str:
    p = os.path.join(company_dir(slug), "identity")
    if os.path.isfile(p):
        return "identity: present (reused)"
    with open(p, "w") as fh:
        fh.write(f"{sk}\n{pk}\n{npub}\n")
    os.chmod(p, 0o600)
    return "identity: written (sk/pk/npub)"


def write_env(slug: str, force: bool) -> str:
    d = company_dir(slug)
    p = os.path.join(d, "env")
    if os.path.isfile(p) and not force:
        return "env: present (kept)"
    sk = load_seckey(slug)
    key = llm_key()
    body = (
        f"LLM_API_KEY={key}\n"
        f"LLM_BASE_URL=https://api.deepseek.com/v1\n"
        f"LLM_MODEL=deepseek-chat\n"
        f"AGENT_VOICE_RELAYS={RELAY}\n"
        f"AGENT_VOICE_STATE={STATE_ROOT}/{slug}\n"
        f"AGENT_VOICE_CARD={d}/card.json\n"
        f"AGENT_VOICE_SECKEY={sk}\n"
        f"DEEPSEEK_API_KEY={key}\n"
    )
    with open(p, "w") as fh:
        fh.write(body)
    os.chmod(p, 0o600)
    os.makedirs(f"{STATE_ROOT}/{slug}", exist_ok=True)
    return "env: written"


def write_unit(slug: str, force: bool) -> str:
    d = company_dir(slug)
    name = f"agent-voice-{slug}"
    p = os.path.join(SYSTEMD_DIR, f"{name}.service")
    desc = slug
    try:
        card = json.load(open(os.path.join(d, "card.json")))
        desc = (card.get("identity") or {}).get("name") or (card.get("name") or {}).get("value") or slug
    except Exception:
        pass
    if os.path.isfile(p) and not force:
        return f"unit: {name}.service present (kept)"
    unit = f"""[Unit]
Description=Helix Agent Voice — {desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile={d}/env
ExecStart={VENV_PY} -m agent_voice
WorkingDirectory={AGENT_DIR}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"""
    with open(p, "w") as fh:
        fh.write(unit)
    return f"unit: {name}.service written"


def activate(slug: str) -> str:
    name = f"agent-voice-{slug}"
    subprocess.run(["systemctl", "daemon-reload"], check=False)
    subprocess.run(["systemctl", "enable", "--now", name], check=False)
    r = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True, check=False)
    return f"{name}: {r.stdout.strip() or 'unknown'}"


# ── main ─────────────────────────────────────────────────────────────────────

def cmd_check(slug: str) -> None:
    d = company_dir(slug)
    ident = os.path.isfile(os.path.join(d, "identity"))
    sec = os.path.isfile(os.path.join(d, "seckey"))
    unit = os.path.isfile(os.path.join(SYSTEMD_DIR, f"agent-voice-{slug}.service"))
    npub = existing_npub(slug)
    print(f"{slug}: identity={'Y' if ident else 'N'} seckey={'Y' if sec else 'N'} "
          f"unit={'Y' if unit else 'N'} card={'Y' if has_card(slug) else 'N'} npub={npub[:20] or '-'}")


def cmd_provision(slug: str, force: bool) -> None:
    if not re.fullmatch(r"[a-z0-9-]+", slug):
        die(f"{slug!r} is not a valid company id")
    if not os.path.isdir(company_dir(slug)):
        die(f"{slug}: no company dir at {company_dir(slug)}")

    sk = load_seckey(slug)
    npub = existing_npub(slug)
    pk = pubkey_hex(sk)
    if not npub:
        npub = npub_of(pk)

    print(f"{slug}:")
    print(f"  npub: {npub}")
    print(f"  {write_identity(slug, sk, pk, npub)}")
    print(f"  {write_env(slug, force)}")
    print(f"  {write_unit(slug, force)}")
    print(f"  {activate(slug)}")
    if not has_card(slug):
        print("  note: no card yet — the agent will answer generically until one exists")


def main(argv: list[str]) -> None:
    if not argv:
        die("usage: provision-voice.py <slug> | --check <slug> | --force <slug>")
    if argv[0] == "--check":
        if len(argv) < 2:
            die("usage: provision-voice.py --check <slug>")
        return cmd_check(argv[1])
    if argv[0] == "--force":
        if len(argv) < 2:
            die("usage: provision-voice.py --force <slug>")
        return cmd_provision(argv[1], force=True)
    return cmd_provision(argv[0], force=False)


if __name__ == "__main__":
    main(sys.argv[1:])
