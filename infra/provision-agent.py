#!/usr/bin/env python3
"""provision-agent.py — give a company its own Card Agent, idempotently.

A company becomes an agent when it has BOTH things to be an agent WITH:

    <company>/card.json   the grounding source — what the agent may know
    <company>/identity    line 1 is the nostr private key — how it is reached

This is what used to be done by hand for demo-barber and santinos: the block
below is copied from a working card agent, not invented. Run it on every
onboard and nothing happens twice; run it after a prune and the phantom agent
that would otherwise linger is what it cleans up.

    provision-agent.py <company-id>            add (or refresh) the agent
    provision-agent.py --remove <company-id>   take the agent out
    provision-agent.py --list                  what is configured right now

It also keeps `[agents.helix].delegates` in step. The Account Agent reaches a
card agent by EXPLICIT roster — card agents sit on the `card_agent` risk profile
and helix on `account_agent`, so `delegate_same_risk_profile` cannot bridge
them, and a company that is missing from the roster is a company the Account
Agent cannot hand work to.

the config is rewritten by the daemon, so: back up, validate, reload.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
from typing import NoReturn

CONFIG = os.environ.get("ZEROCLAW_CONFIG", "/etc/zeroclaw/config.toml")
COMPANIES = os.environ.get("HELIX_COMPANIES", "/etc/helix/companies")
ZEROCLAW_HOME = os.environ.get("ZEROCLAW_HOME", "/etc/zeroclaw")
RELAY = os.environ.get("HELIX_RELAY", "wss://omokoda.duckdns.org:3443")
SPARK_MCP = os.environ.get("SPARK_GATE_MCP", "/usr/local/bin/spark-gate-mcp")
ACCOUNT_AGENT = os.environ.get("HELIX_ACCOUNT_AGENT", "helix")
RESTART = os.environ.get("ZEROCLAW_RESTART", "1") == "1"


def die(msg: str, code: int = 1) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def read_config() -> str:
    try:
        return open(CONFIG).read()
    except FileNotFoundError:
        die(f"no config at {CONFIG}")


def agent_block(name: str) -> str:
    """The [agents.<name>] table, or '' when it is not configured."""
    m = re.search(rf"(?m)^\[agents\.{re.escape(name)}\]\n(.*?)(?=\n\[|\Z)", read_config(), re.S)
    return m.group(0) if m else ""


def channel_key(cfg: str, name: str) -> str | None:
    """The nostr private key currently wired to a company's channel.

    This lives in [channels.nostr.<name>], NOT in the [agents.<name>] block — the
    two are separate tables, and looking for the key in the agent block is how a
    re-run silently rotates a live credential instead of no-opping."""
    m = re.search(rf"(?m)^\[channels\.nostr\.{re.escape(name)}\]\n(.*?)(?=\n\[|\Z)", cfg, re.S)
    if not m:
        return None
    k = re.search(r'private_key = "([0-9a-f]{64})"', m.group(1))
    return k.group(1) if k else None


def utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ── the block we write ───────────────────────────────────────────────────────

def render_agent(cid: str, privkey: str, stamp: str) -> str:
    d = f"{COMPANIES}/{cid}"
    return f"""

# ─── Company: {cid} ──────────────────────────────────────────────────────────
# Provisioned automatically by infra/provision-agent.py on {stamp}.
# A card agent is scoped to its own business and delegates to nobody: it has no
# delegation_policy, so ZeroClaw denies delegation for it by default.

[agents.{cid}]
acp_enable_mcp = false
delegate_same_risk_profile = true
enabled = true
model_provider = "openai.deepseek"
risk_profile = "card_agent"
mcp_bundles = ["{cid}_tools"]
channels = ["nostr.{cid}"]
knowledge_bundles = ["{cid}_card"]

[agents.{cid}.a2a]
published = false

[agents.{cid}.identity]
format = "openclaw"

[agents.{cid}.memory]
backend = "sqlite"

[agents.{cid}.precheck]
enabled = true
timeout_secs = 5

[agents.{cid}.workspace]
unrestricted_filesystem = false

[channels.nostr.{cid}]
enabled = true
private_key = "{privkey}"
relays = ["{RELAY}"]

[peer_groups.{cid}_trusted]
channel = "nostr.{cid}"
agents = ["{cid}"]
external_peers = []

[[mcp.servers]]
name = "spark_{cid}"
transport = "stdio"
command = "{SPARK_MCP}"
args = []
tool_timeout_secs = 30
pinned_resources = ["card://local/current"]
env = {{ SPARK_INVOKE_URL = "http://127.0.0.1:9100/invoke", SPARK_CARD = "{d}/card.json", SPARK_POLICY_SEED = "{d}/policy-seed.json", SPARK_TOOL_ALLOWLIST = "{d}/tool-allowlist.json" }}

[mcp_bundles.{cid}_tools]
servers = ["spark_{cid}"]
exclude = []

[knowledge_bundles.{cid}_card]
sources = ["{d}/CARD.md"]
tags = ["card", "{cid}"]
"""


# ── the agent's identity ─────────────────────────────────────────────────────

SOUL_HEADER = (
    "<!-- This file is the agent's identity, loaded every session.\n"
    "     Compiled from the Business DNA card — DO NOT HAND-EDIT.\n"
    "     Re-extract and recompile; a hand edit here drifts from the card. -->\n\n"
)


def soul_path(cid: str) -> str:
    return os.path.join(ZEROCLAW_HOME, "agents", cid, "workspace", "SOUL.md")


def persona_from_card(cid: str) -> str | None:
    """A persona rendered straight from card.json.

    The compiled system-prompt.md is what we prefer, but a card agent whose only
    identity is ZeroClaw's stock "You are <alias>. Built in Rust." answers about
    nothing — grounding has to survive a missing sidecar."""
    p = os.path.join(company_dir(cid), "card.json")
    try:
        card = json.loads(open(p).read())
    except Exception:
        return None
    ident = card.get("identity") or {}
    name = ident.get("name") or cid
    lines = [f"You are the AI employee of **{name}**."]
    if ident.get("elevator_pitch"):
        lines.append(str(ident["elevator_pitch"]))
    if ident.get("location"):
        lines.append(f"Location: {ident['location']}")
    if ident.get("phone"):
        lines.append(f"Phone: {ident['phone']}")
    ops = card.get("operations") or {}
    if ops.get("hours"):
        lines.append(f"\n## Hours\n{ops['hours']}")
    off = card.get("offerings") or []
    if off:
        lines.append("\n## What the business offers")
        lines += [f"- {o.get('name')} (price: {o.get('price') or 'not on record'})"
                  for o in off]
    voice = card.get("voice") or {}
    if voice.get("tone") or voice.get("personality"):
        lines.append("\n## Voice")
        if voice.get("tone"):
            lines.append(f"Tone: {', '.join(voice['tone'])}.")
        if voice.get("personality"):
            lines.append(f"Personality: {voice['personality']}")
        for d in voice.get("donts") or []:
            lines.append(f"Never: {d}")
    pol = card.get("policies") or []
    if pol:
        lines.append("\n## Policies (binding)")
        for x in pol:
            if isinstance(x, dict):
                lines.append(f"- **{x.get('kind', 'policy')}**: {x.get('text', '')}")
    lines.append("\nAnswer only from this card. If something is not on it, say so and "
                 "offer to connect the customer with a team member. Never invent prices.")
    return "\n".join(lines)


def install_soul(cid: str) -> str:
    """Write the agent's SOUL.md from the card. Returns a one-line status."""
    compiled = os.path.join(company_dir(cid), "system-prompt.md")
    if os.path.isfile(compiled):
        body, origin = open(compiled).read(), "system-prompt.md"
    else:
        body = persona_from_card(cid)
        if not body:
            return "no card.json — SOUL.md left alone"
        origin = "card.json (system-prompt.md missing)"
    dst = soul_path(cid)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isfile(dst):
        shutil.copy2(dst, f"{dst}.prev-{utcnow():%Y%m%d%H%M%S}")
    open(dst, "w").write(SOUL_HEADER + body)
    return f"SOUL.md <- {origin} ({len(body)} bytes)"


def cmd_sync_soul(ids: list[str]) -> None:
    cfg = read_config()
    for cid in (ids or card_agents(cfg)):
        print(f"{cid}: {install_soul(cid)}")


# ── roster maintenance ───────────────────────────────────────────────────────

def card_agents(cfg: str) -> list[str]:
    """Every agent alias configured on the `card_agent` risk profile."""
    out = []
    for m in re.finditer(r"(?m)^\[agents\.([^\].]+)\]\n(.*?)(?=\n\[|\Z)", cfg, re.S):
        if re.search(r'(?m)^risk_profile = "card_agent"', m.group(2)):
            out.append(m.group(1))
    return sorted(set(out))


def set_delegates(cfg: str, targets: list[str]) -> str:
    """Point [agents.helix].delegates at exactly `targets`."""
    block = re.search(
        rf"(?m)^\[agents\.{re.escape(ACCOUNT_AGENT)}\]\n(.*?)(?=\n\[|\Z)", cfg, re.S)
    if not block:
        return cfg
    body = block.group(1)
    line = "delegates = [" + ", ".join(f'"{t}"' for t in targets) + "]"
    if re.search(r"(?m)^delegates = \[.*\]$", body):
        new_body = re.sub(r"(?m)^delegates = \[.*\]$", line, body)
    elif re.search(r"(?m)^delegate_same_risk_profile = .*$", body):
        new_body = re.sub(r"(?m)^(delegate_same_risk_profile = .*)$", r"\1\n" + line, body)
    else:
        new_body = body.rstrip("\n") + "\n" + line + "\n"
    return cfg[: block.start(1)] + new_body + cfg[block.end(1):]


def drop_agent(cfg: str, cid: str) -> str:
    """Remove every table that belongs to one company's agent."""
    names = [f"agents.{cid}", f"agents.{cid}.a2a", f"agents.{cid}.identity",
             f"agents.{cid}.memory", f"agents.{cid}.precheck",
             f"agents.{cid}.workspace", f"channels.nostr.{cid}",
             f"peer_groups.{cid}_trusted", f"mcp_bundles.{cid}_tools",
             f"knowledge_bundles.{cid}_card"]
    for n in names:
        cfg = re.sub(rf"(?m)^\[{re.escape(n)}\]\n(?:.*?\n)*?(?=\n\[|\Z)", "", cfg)
    # The [[mcp.servers]] element named spark_<cid>. Every line of the span must
    # not itself start a table — without that guard the lazy span happily runs
    # from the FIRST [[mcp.servers]] past every other server to reach this one,
    # and removing a company would quietly strip the whole MCP registry.
    cfg = re.sub(
        rf"(?m)^\[\[mcp\.servers\]\]\n(?:(?!\[).*\n)*?name = \"spark_{re.escape(cid)}\"\n(?:(?!\[).*\n)*",
        "", cfg)
    # and the comment header the provisioner writes above the block, so a removed
    # company leaves nothing at all behind
    cfg = re.sub(rf"(?m)^# ─+ Company: {re.escape(cid)} ─+\n(?:#[^\n]*\n)*", "", cfg)
    return cfg


# ── main ─────────────────────────────────────────────────────────────────────

def company_dir(cid: str) -> str:
    return os.path.join(COMPANIES, cid)


def load_privkey(cid: str) -> str:
    ident = os.path.join(company_dir(cid), "identity")
    if not os.path.isfile(ident):
        die(f"{cid}: no {ident} — the company has no nostr identity yet, so it "
            f"cannot be reached as an agent")
    first = open(ident).read().splitlines()[0].strip()
    if not re.fullmatch(r"[0-9a-f]{64}", first):
        die(f"{cid}: {ident} line 1 is not a 64-hex nostr private key")
    return first


def reload_daemon() -> None:
    if not RESTART:
        print("  (ZEROCLAW_RESTART=0 — not restarting)")
        return
    subprocess.run(["systemctl", "restart", "zeroclaw"], check=False)
    print("  zeroclaw restarted")


def cmd_list() -> None:
    cfg = read_config()
    agents = card_agents(cfg)
    print(f"card agents configured: {len(agents)}")
    for a in agents:
        d = company_dir(a)
        card = "card.json" if os.path.isfile(os.path.join(d, "card.json")) else "NO CARD"
        ident = "identity" if os.path.isfile(os.path.join(d, "identity")) else "NO IDENTITY"
        print(f"  {a:<24} {card:<10} {ident}")
    helm = re.search(
        rf"(?m)^\[agents\.{re.escape(ACCOUNT_AGENT)}\]\n(.*?)(?=\n\[|\Z)", cfg, re.S)
    if helm:
        m = re.search(r"(?m)^delegates = \[(.*)\]$", helm.group(1))
        print(f"\n[agents.{ACCOUNT_AGENT}].delegates = "
              f"{m.group(1) if m else '(absent — the Account Agent reaches nobody)'}")


def cmd_remove(cid: str) -> None:
    cfg = read_config()
    if not agent_block(cid):
        print(f"{cid}: no agent configured; nothing to remove")
        return
    shutil.copy2(CONFIG, f"{CONFIG}.bak-decommission-{utcnow():%Y%m%d%H%M%S}")
    cfg = drop_agent(cfg, cid)
    cfg = set_delegates(cfg, card_agents(cfg))
    open(CONFIG, "w").write(cfg)
    print(f"{cid}: agent removed; delegates now {card_agents(cfg)}")
    reload_daemon()


def cmd_add(cid: str) -> None:
    if not re.fullmatch(r"[a-z0-9-]+", cid):
        die(f"{cid!r} is not a valid company id (lowercase letters, digits, hyphens)")

    card = os.path.join(company_dir(cid), "card.json")
    cardmd = os.path.join(company_dir(cid), "CARD.md")
    if not (os.path.isfile(card) or os.path.isfile(cardmd)):
        die(f"{cid}: no card.json/CARD.md in {company_dir(cid)} — a card agent with "
            f"nothing to ground on would answer out of thin air")

    cfg = read_config()
    stamp = f"{utcnow():%Y-%m-%d}"
    existing = agent_block(cid)
    privkey = load_privkey(cid)

    for sidecar in ("policy-seed.json", "tool-allowlist.json"):
        if not os.path.isfile(os.path.join(company_dir(cid), sidecar)):
            print(f"  warning: {sidecar} missing — compile the card before the agent "
                  f"can call its gate")

    if existing:
        # Idempotent re-run: the only thing that can legitimately change is the
        # channel key, and only when identity's key1 has moved.
        wired = channel_key(cfg, cid)
        if wired == privkey:
            print(f"{cid}: agent already configured and its channel key matches — no change")
            print(f"  {install_soul(cid)}")
            return
        cfg = drop_agent(cfg, cid)
        print(f"{cid}: rotating the channel key to match {company_dir(cid)}/identity")

    shutil.copy2(CONFIG, f"{CONFIG}.bak-provision-{utcnow():%Y%m%d%H%M%S}")
    cfg = cfg.rstrip("\n") + "\n" + render_agent(cid, privkey, stamp)
    cfg = set_delegates(cfg, card_agents(cfg))
    open(CONFIG, "w").write(cfg)
    print(f"{cid}: agent written; delegates now {card_agents(cfg)}")
    print(f"  {install_soul(cid)}")
    reload_daemon()


def main(argv: list[str]) -> None:
    if not argv:
        die("usage: provision-agent.py <company-id> | --remove <company-id> | "
            "--sync-soul [company-id ...] | --list")
    if argv[0] == "--list":
        return cmd_list()
    if argv[0] == "--sync-soul":
        return cmd_sync_soul(argv[1:])
    if argv[0] == "--remove":
        if len(argv) < 2:
            die("usage: provision-agent.py --remove <company-id>")
        return cmd_remove(argv[1])
    return cmd_add(argv[0])


if __name__ == "__main__":
    main(sys.argv[1:])
