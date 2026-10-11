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


def render_block(provider: str, model: str, key: str) -> str:
    uri = OPENAI_COMPAT[provider]
    return f"""
# ─── Chat-agent provider, rendered from /etc/helix/settings.json ─────────────
# Written by infra/sync-agent-provider.py. Editing by hand is pointless: the next
# Settings save overwrites it. The dashboard's Settings page is the source of
# truth for provider/model/key, for the agents exactly as for the API.

[providers.models.openai.{BLOCK_ALIAS}]
api_key = "{key}"
uri = "{uri}"
model = "{model}"
kind = "openai-compatible"
"""


def apply() -> None:
    s = read_settings()
    provider, model, key = resolve(s)

    if provider in NOT_OPENAI_COMPAT:
        die(f"provider '{provider}' is not OpenAI-compatible; the agent runtime "
            f"cannot be pointed at it through this block. Pick another provider in "
            f"Settings, or wire a native {provider} provider block by hand.")
    if provider not in OPENAI_COMPAT:
        die(f"unknown provider '{provider}'")
    if not model:
        die(f"settings.json has no model for provider '{provider}' — set one in Settings")
    if not key:
        die(f"no key for provider '{provider}' (not in settings.json and no "
            f"environment fallback) — the agents cannot authenticate")

    cfg = open(CONFIG).read()
    before = cfg

    # 1. the provider block: replace if present, else append
    block = render_block(provider, model, key).strip("\n")
    existing = re.search(
        rf'(?m)^\[providers\.models\.openai\.{BLOCK_ALIAS}\]\n(?:.*?\n)*?(?=\n\[|\Z)', cfg)
    if existing:
        cfg = cfg[:existing.start()] + block + "\n" + cfg[existing.end():]
        print(f"  provider block: replaced ({provider} / {model})")
    else:
        cfg = cfg.rstrip("\n") + "\n\n" + block + "\n"
        print(f"  provider block: added ({provider} / {model})")

    # 2. every agent points at it
    n = len(re.findall(r'(?m)^model_provider = "[^"]*"', cfg))
    cfg = re.sub(r'(?m)^model_provider = "[^"]*"',
                 f'model_provider = "openai.{BLOCK_ALIAS}"', cfg)
    print(f"  agents repointed: {n}")

    if cfg == before:
        print("  no change")
        return

    stamp = f"{datetime.datetime.utcnow():%Y%m%d%H%M%S}"
    shutil.copy2(CONFIG, f"{CONFIG}.bak-llmsync-{stamp}")
    open(CONFIG, "w").write(cfg)

    if not RESTART:
        print("  (ZEROCLAW_RESTART=0 — not restarting)")
        return
    subprocess.run(["systemctl", "restart", "zeroclaw"], check=False)
    print("  zeroclaw restarted — agents now use the Settings provider")


def main(argv: list[str]) -> None:
    if argv and argv[0] == "--status":
        return status()
    apply()


if __name__ == "__main__":
    main(sys.argv[1:])
