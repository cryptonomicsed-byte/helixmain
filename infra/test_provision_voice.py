"""Tests for provision-voice.py. Run: python3 -m pytest infra/test_provision_voice.py"""
import importlib.util
import json
import os
import stat
from pathlib import Path

import pytest

SK_A, SK_B = "11" * 32, "22" * 32


@pytest.fixture
def pv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "provision_voice", Path(__file__).with_name("provision-voice.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "COMPANIES", str(tmp_path / "companies"))
    monkeypatch.setattr(mod, "STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setattr(mod, "SYSTEMD_DIR", str(tmp_path / "systemd"))
    monkeypatch.setattr(mod, "TEXT_AGENT_DIR", str(tmp_path / "helix-agent"))
    monkeypatch.setattr(mod, "RELAY", "wss://relay.example:3443/relay")
    monkeypatch.setenv("LLM_API_KEY", "llm-key")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    (tmp_path / "systemd").mkdir()
    for slug, sk, cid in (("alpha", SK_A, "dna_alpha"), ("beta", SK_B, "dna_beta")):
        d = tmp_path / "companies" / slug
        d.mkdir(parents=True)
        (d / "seckey").write_text(sk + "\n")
        (d / "card.json").write_text(json.dumps({"id": cid, "identity": {"name": slug}}))
    return mod


def read_env(path):
    return dict(line.strip().split("=", 1) for line in open(path) if "=" in line)


def test_each_company_gets_its_own_stable_bridge_port(pv):
    a, b = pv.http_port("alpha"), pv.http_port("beta")
    assert a != b and a in pv.HTTP_PORT_RANGE and b in pv.HTTP_PORT_RANGE
    assert pv.http_port("alpha") == a          # allocated once


def test_env_enables_memory_with_the_companys_own_key_and_the_bridge(pv, tmp_path):
    pv.write_env("alpha", force=False)
    pv.write_env("beta", force=False)
    a = read_env(tmp_path / "companies/alpha/env")
    b = read_env(tmp_path / "companies/beta/env")
    assert a["NIPAE_NSEC"] == SK_A and b["NIPAE_NSEC"] == SK_B       # never shared
    assert a["NIPAE_RELAYS"] == "wss://relay.example:3443/relay"
    assert a["AGENT_VOICE_HTTP_PORT"] == str(pv.http_port("alpha"))
    mode = stat.S_IMODE(os.stat(tmp_path / "companies/alpha/env").st_mode)
    assert mode == 0o600


def test_existing_env_keeps_operator_edits_and_gains_only_missing_settings(pv, tmp_path):
    env = tmp_path / "companies/alpha/env"
    env.write_text("LLM_MODEL=custom-model\nAGENT_VOICE_SECKEY=" + SK_A + "\n")
    out = pv.write_env("alpha", force=False)
    got = read_env(env)
    assert got["LLM_MODEL"] == "custom-model"
    assert "NIPAE_NSEC" in got and "AGENT_VOICE_HTTP_PORT" in got
    assert "added" in out
    assert pv.write_env("alpha", force=False) == "env: present (kept)"   # idempotent


def test_text_agent_shares_identity_and_points_at_its_own_companys_brain(pv, tmp_path):
    pv.write_text_env("alpha", force=False)
    pv.write_text_unit("alpha", force=False)
    t = read_env(tmp_path / "companies/alpha/text-env")
    assert t["HELIX_NSEC_HEX"] == SK_A
    assert t["HELIX_BRAIN_URL"] == f"http://127.0.0.1:{pv.http_port('alpha')}"
    assert t["HELIX_CARD_ID"] == "dna_alpha"
    assert t["HELIX_RELAY_AUTH_TAG"] == "wss://relay.example:3443"      # path stripped for NIP-42
    unit = (tmp_path / "systemd/helix-agent-alpha.service").read_text()
    assert "EnvironmentFile=" + str(tmp_path / "companies/alpha/text-env") in unit
    assert "RestartPreventExitStatus=2 3" in unit


def test_text_agent_is_skipped_when_not_installed(pv, tmp_path):
    assert not pv.text_agent_installed()
    (tmp_path / "helix-agent").mkdir()
    (tmp_path / "helix-agent" / "agent.py").write_text("")
    assert pv.text_agent_installed()
