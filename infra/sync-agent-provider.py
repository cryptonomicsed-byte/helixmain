#!/usr/bin/env python3
"""sync-agent-provider.py — make the CHAT AGENTS use the key in Settings.

The dashboard's Settings page writes /etc/helix/settings.json. Everything the API
does (extraction, content, landing pages, greeting) resolves provider+model+key
through services/settings.ts and so honours it.

The chat agents did NOT. ZeroClaw reads its own /etc/zeroclaw/config.toml, where
every agent said `model_provider = "openai.deepseek"` and the key sat in a
hand-written provider block. So a user could paste a Google key, watch Settings
confirm it, and every chat reply would still be DeepSeek — which reads exactly
like "the app is hardcoded to DeepSeek".

This closes that gap: it renders ONE provider block from settings.json and points
every agent at it.

    sync-agent-provider.py            apply settings.json to the agent runtime
    sync-agent-provider.py --status   show what the agents are using now

Providers are reached through their OpenAI-compatible endpoints, so one
`kind = "openai-compatible"` block covers all of them. Anthropic is the one
exception (its API is not OpenAI-shaped) and is reported rather than faked.
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
SETTINGS = os.environ.get("HELIX_SETTINGS_FILE", "/etc/helix/settings.json")
COMPANIES_DIR = os.environ.get("HELIX_COMPANIES_DIR", "/etc/helix/companies")
RESTART = os.environ.get("ZEROCLAW_RESTART", "1") == "1"

# provider → (base for chat/completions, api style)
OPENAI_COMPAT: dict[str, str] = {
    "deepseek":   "https://api.deepseek.com/v1",
    "openai":     "https://api.openai.com/v1",
    "gemini":     "https://generativelanguage.googleapis.com/v1beta/openai",
    "groq":       "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "mistral":    "https://api.mistral.ai/v1",
}
# Anthropic's Messages API is not OpenAI-shaped; mapping it onto this block would
# produce a runtime that 404s on every turn. Say so instead.
NOT_OPENAI_COMPAT = {"anthropic"}

BLOCK_ALIAS = "helix_llm"   # [providers.models.openai.helix_llm]


def die(msg: str) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def read_settings() -> dict:
    try:
        return json.load(open(SETTINGS))
    except FileNotFoundError:
        die(f"no settings at {SETTINGS}")
    except json.JSONDecodeError as e:
        die(f"{SETTINGS} is not valid JSON: {e}")


def resolve(settings: dict) -> tuple[str, str, str]:
    provider = settings.get("provider") or "deepseek"
    model = settings.get("model") or ""
    key = (settings.get("keys") or {}).get(provider) or ""

    # Fall back to env exactly like services/settings.ts keyFor() does, so the
    # agents and the API never disagree about which key is in play.
    if not key:
        env_name = {
            "deepseek": "DEEPSEEK_API_KEY", "openai": "OPENAI_API_KEY",
            "gemini": "GEMINI_API_KEY", "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY", "mistral": "MISTRAL_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
        }.get(provider, "")
        key = os.environ.get(env_name, "")
    return provider, model, key


def status() -> None:
    s = read_settings()
    provider, model, key = resolve(s)
    print(f"settings.json : provider={provider} model={model or '(default)'} key={'yes' if key else 'NO'}")
    cfg = open(CONFIG).read()
    used = sorted(set(re.findall(r'(?m)^model_provider = "([^"]+)"', cfg)))
    print(f"agents say    : {', '.join(used) if used else '(none)'}")
    block = re.search(rf'(?m)^\[providers\.models\.openai\.{BLOCK_ALIAS}\]\n(.*?)(?=\n\[|\Z)', cfg, re.S)
    if block:
        b = block.group(1)
        m = re.search(r'uri = "([^"]+)"', b)
        mm = re.search(r'model = "([^"]+)"', b)
        print(f"generated block: uri={m.group(1) if m else '?'} model={mm.group(1) if mm else '?'}")
    else:
        print("generated block: (absent — agents are on a hand-written provider)")


def render_block(provider: str, model: str, key: str, alias: str, owner: str) -> str:
    uri = OPENAI_COMPAT[provider]
    return f"""
# ─── Chat-agent provider: {owner} ─────────────
# Written by infra/sync-agent-provider.py. Editing by hand is pointless: the next
# Settings save overwrites it. The Settings page is the source of truth for
# provider/model/key — the ACCOUNT page for {BLOCK_ALIAS}, a card's own settings
# page for that card.

[providers.models.openai.{alias}]
api_key = "{key}"
uri = "{uri}"
model = "{model}"
kind = "openai-compatible"
"""


def agents_in(cfg: str) -> list[str]:
    return re.findall(r"(?m)^\[agents\.([^\].]+)\]$", cfg)


def company_ai(org: str) -> dict:
    """A card's own AI settings, if it has any (matches services/settings.ts)."""
    p = os.path.join(COMPANIES_DIR, org, "ai.json")
    try:
        return json.load(open(p))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def resolve_for(org: str, account: tuple[str, str, str]) -> tuple[str, str, str, str]:
    """(provider, model, key, owner) for ONE agent.

    Card override wins over the account — the same precedence the API's
    keyForProvider()/resolveModel() use, so the chat agents and the API can never
    disagree about which key a business is billed/authenticated with.
    """
    a_provider, a_model, a_key = account
    ai = company_ai(org)
    provider = ai.get("provider") or a_provider
    model = ai.get("model") or (a_model if provider == a_provider else "")
    key = (ai.get("keys") or {}).get(provider) or (a_key if provider == a_provider else "")
    if provider == a_provider and model and key:
        owner = "card override + account fallback" if ai else "account settings"
    else:
        owner = "card settings"
    return provider, model or "", key, owner


def apply() -> None:
    s = read_settings()
    account = resolve(s)          # (provider, model, key) — the account default
    a_provider, a_model, a_key = account

    if a_provider in NOT_OPENAI_COMPAT:
        die(f"provider '{a_provider}' is not OpenAI-compatible; the agent runtime "
            f"cannot be pointed at it through this block. Pick another provider in "
            f"Settings, or wire a native {a_provider} provider block by hand.")
    if a_provider not in OPENAI_COMPAT:
        die(f"unknown provider '{a_provider}'")
    if not a_model:
        die(f"settings.json has no model for provider '{a_provider}' — set one in Settings")
    if not a_key:
        die(f"no key for provider '{a_provider}' (not in settings.json and no "
            f"environment fallback) — the agents cannot authenticate")

    cfg = open(CONFIG).read()
    before = cfg
    blocks: list[str] = []
    plan: dict[str, str] = {}     # agent alias → provider alias it should use

    for org in agents_in(cfg):
        provider, model, key, owner = resolve_for(org, account)
        if provider in NOT_OPENAI_COMPAT:
            scope = "the account" if org == a_provider else f"card '{org}'"
            print(f"  {org:<18} SKIPPED — {scope} selects '{provider}', which is not "
                  f"OpenAI-compatible")
            plan[org] = f"openai.{BLOCK_ALIAS}"
            continue
        if provider == a_provider and model == a_model and key == a_key:
            plan[org] = f"openai.{BLOCK_ALIAS}"
            continue
        # this card overrides the account — it needs its own block
        alias = f"{BLOCK_ALIAS}_{re.sub(r'[^a-zA-Z0-9_-]', '_', org)}"
        blocks.append(render_block(provider, model, key, alias, f"card '{org}' ({owner})"))
        plan[org] = f"openai.{alias}"
        print(f"  {org:<18} own block: {alias} ({provider} / {model})")

    # the account block ALWAYS exists (agents fall back to it)
    blocks.insert(0, render_block(a_provider, a_model, a_key, BLOCK_ALIAS, "account settings"))
    print(f"  account block: {BLOCK_ALIAS} ({a_provider} / {a_model})")

    # drop our previously-generated blocks, then re-add the current set
    cfg = re.sub(rf"(?m)^# ─── Chat-agent provider:.*?(?=^\[|\Z)", "", cfg, flags=re.S)
    cfg = re.sub(rf"(?m)^\[providers\.models\.openai\.{BLOCK_ALIAS}[^\]]*\]\n(?:.*?\n)*?(?=\n\[|\Z)",
                 "", cfg)
    # remove the old auto-generated comment banner too
    cfg = re.sub(r"(?m)^# ─── Chat-agent provider.*\n(?:#.*\n)*\n?", "", cfg)

    # point each agent at the provider its own scope resolves to
    lines = cfg.split("\n")
    out: list[str] = []
    current: str | None = None
    for ln in lines:
        m = re.match(r"^\[agents\.([^\].]+)\]$", ln)
        if m:
            current = m.group(1)
        if ln.startswith("model_provider = ") and current in plan:
            ln = f'model_provider = "{plan[current]}"'
        out.append(ln)
    cfg = "\n".join(out)

    cfg = cfg.rstrip("\n") + "\n\n" + "\n".join(b.strip("\n") for b in blocks) + "\n"
    print(f"  provider blocks written: {len(blocks)}")
    print(f"  agents repointed: {len(plan)}")

    if cfg == before:
        print("  no change")
        return

    stamp = f"{datetime.datetime.now(datetime.timezone.utc):%Y%m%d%H%M%S}"
    shutil.copy2(CONFIG, f"{CONFIG}.bak-llmsync-{stamp}")
    open(CONFIG, "w").write(cfg)

    if not RESTART:
        print("  (ZEROCLAW_RESTART=0 — not restarting)")
        return
    subprocess.run(["systemctl", "restart", "zeroclaw"], check=False)
    print("  zeroclaw restarted — agents now use the Settings provider(s)")


def main(argv: list[str]) -> None:
    if argv and argv[0] == "--status":
        return status()
    apply()


if __name__ == "__main__":
    main(sys.argv[1:])
