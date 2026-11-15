#!/usr/bin/env python3
"""provision-voice.py — give a company its voice endpoint, idempotently.

A company can answer a call only when four things exist on the VPS:

    <slug>/identity                sk / pk / npub   (the /call page reads the npub)
    <slug>/env                     the agent's runtime env (LLM key, relay, card, seckey,
                                   per-card memory, local chat bridge port)
    agent-voice-<slug>.service     the systemd unit
    the unit                      enabled and started

When helix-agent is installed (/opt/helix-agent/agent.py) the company also gets
its text-DM agent, helix-agent-<slug>.service. It uses the SAME identity and
sends chat to the voice agent's local bridge, so text and voice are one
card-grounded agent, not two.

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
TEXT_AGENT_DIR = os.environ.get("HELIX_TEXT_AGENT_DIR", "/opt/helix-agent")
HTTP_PORT_RANGE = range(8401, 9000)      # loopback chat bridge, one port per company


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


def http_port(slug: str) -> int:
    """The company's loopback chat-bridge port: allocated once, then stable."""
    p = os.path.join(company_dir(slug), "http_port")
    if os.path.isfile(p):
        try:
            return int(open(p).read().strip())
        except ValueError:
            pass
    taken = set()
    for other in os.listdir(COMPANIES):
        q = os.path.join(COMPANIES, other, "http_port")
        if os.path.isfile(q):
            try:
                taken.add(int(open(q).read().strip()))
            except ValueError:
                pass
    port = next((n for n in HTTP_PORT_RANGE if n not in taken), None)
    if port is None:
        die("no free chat-bridge port left in the configured range")
    with open(p, "w") as fh:
        fh.write(f"{port}\n")
    return port


def env_settings(slug: str) -> dict[str, str]:
    """Every setting the voice agent's env file must carry."""
    d = company_dir(slug)
    sk = load_seckey(slug)
    key = llm_key()
    return {
        "LLM_API_KEY": key,
        "LLM_BASE_URL": "https://api.deepseek.com/v1",
        "LLM_MODEL": "deepseek-chat",
        "AGENT_VOICE_RELAYS": RELAY,
        "AGENT_VOICE_STATE": f"{STATE_ROOT}/{slug}",
        "AGENT_VOICE_CARD": f"{d}/card.json",
        "AGENT_VOICE_SECKEY": sk,
        "DEEPSEEK_API_KEY": key,
        # Per-card memory (mem/card/<id>/*). The memory key is the company's own
        # key, so no two businesses ever share one; without these the agent
        # silently runs with memory off.
        "NIPAE_NSEC": sk,
        "NIPAE_RELAYS": RELAY,
        # Loopback chat bridge: the dashboard and the text agent reach the same
        # card-grounded agent that answers calls.
        "AGENT_VOICE_HTTP_PORT": str(http_port(slug)),
    }


def _write_env_file(path: str, wanted: dict[str, str], force: bool) -> str:
    """Write an env file, or add only the settings an existing one is missing.

    An existing file is never rewritten without --force: an operator may have
    changed a model or relay by hand. Settings added since it was written are
    appended so older companies pick them up.
    """
    if os.path.isfile(path) and not force:
        have = {line.split("=", 1)[0] for line in open(path) if "=" in line}
        missing = {k: v for k, v in wanted.items() if k not in have}
        if not missing:
            return "present (kept)"
        with open(path, "a") as fh:
            fh.write("".join(f"{k}={v}\n" for k, v in missing.items()))
        os.chmod(path, 0o600)
        return f"present; added {', '.join(sorted(missing))}"
    with open(path, "w") as fh:
        fh.write("".join(f"{k}={v}\n" for k, v in wanted.items()))
    os.chmod(path, 0o600)
    return "written"


def write_env(slug: str, force: bool) -> str:
    result = _write_env_file(os.path.join(company_dir(slug), "env"), env_settings(slug), force)
    os.makedirs(f"{STATE_ROOT}/{slug}", exist_ok=True)
    return f"env: {result}"


# ── text agent (helix-agent): same identity, same brain ──────────────────────

def text_agent_installed() -> bool:
    return os.path.isfile(os.path.join(TEXT_AGENT_DIR, "agent.py"))


def card_id(slug: str) -> str:
    try:
        card = json.load(open(os.path.join(company_dir(slug), "card.json")))
        return str(card.get("id") or "")
    except Exception:
        return ""


def text_env_settings(slug: str) -> dict[str, str]:
    from urllib.parse import urlparse
    relay = urlparse(RELAY)
    state = f"{STATE_ROOT}/{slug}/text"
    settings = {
        "HELIX_NSEC_HEX": load_seckey(slug),
        "HELIX_RELAY_WS": RELAY,
        "HELIX_RELAY_AUTH_TAG": f"{relay.scheme}://{relay.netloc}",   # NIP-42: no path
        # One brain: chat goes to this company's voice agent, never a second prompt.
        "HELIX_BRAIN_URL": f"http://127.0.0.1:{http_port(slug)}",
        "HELIX_STATE_DIR": state,
        "HELIX_LOG_PATH": f"{state}/helix-agent.log",
    }
    cid = card_id(slug)
    if cid:
        settings["HELIX_CARD_ID"] = cid       # refuse to start against another business's brain
    return settings


def write_text_env(slug: str, force: bool) -> str:
    result = _write_env_file(os.path.join(company_dir(slug), "text-env"),
                             text_env_settings(slug), force)
    os.makedirs(f"{STATE_ROOT}/{slug}/text", exist_ok=True)
    return f"text-env: {result}"


def write_text_unit(slug: str, force: bool) -> str:
    d = company_dir(slug)
    name = f"helix-agent-{slug}"
    p = os.path.join(SYSTEMD_DIR, f"{name}.service")
    if os.path.isfile(p) and not force:
        return f"unit: {name}.service present (kept)"
    unit = f"""[Unit]
Description=Helix text agent — {slug}
After=network-online.target agent-voice-{slug}.service
Wants=network-online.target agent-voice-{slug}.service

[Service]
Type=simple
EnvironmentFile={d}/text-env
ExecStart={VENV_PY} {TEXT_AGENT_DIR}/agent.py
WorkingDirectory={TEXT_AGENT_DIR}
Restart=on-failure
RestartSec=10
# exit 2 = relay refused the identity, exit 3 = brain serves another business:
# neither is fixed by restarting.
RestartPreventExitStatus=2 3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"""
    with open(p, "w") as fh:
        fh.write(unit)
    return f"unit: {name}.service written"


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


def activate(slug: str, name: str | None = None) -> str:
    name = name or f"agent-voice-{slug}"
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
    text_unit = os.path.isfile(os.path.join(SYSTEMD_DIR, f"helix-agent-{slug}.service"))
    npub = existing_npub(slug)
    env_path = os.path.join(d, "env")
    have = {line.split("=", 1)[0] for line in open(env_path) if "=" in line} if os.path.isfile(env_path) else set()
    print(f"{slug}: identity={'Y' if ident else 'N'} seckey={'Y' if sec else 'N'} "
          f"unit={'Y' if unit else 'N'} card={'Y' if has_card(slug) else 'N'} "
          f"memory={'Y' if 'NIPAE_NSEC' in have else 'N'} "
          f"bridge={'Y' if 'AGENT_VOICE_HTTP_PORT' in have else 'N'} "
          f"text-agent={'Y' if text_unit else 'N'} npub={npub[:20] or '-'}")


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
    if text_agent_installed():
        print(f"  {write_text_env(slug, force)}")
        print(f"  {write_text_unit(slug, force)}")
        print(f"  {activate(slug, f'helix-agent-{slug}')}")
    else:
        print(f"  text agent: skipped (no {TEXT_AGENT_DIR}/agent.py)")
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
