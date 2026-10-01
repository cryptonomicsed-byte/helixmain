"""Per-agent structured LLM extraction — the "world-class brand strategist"
prompt pattern from Sacred Core's enhancedExtractionService, split per agent
instead of one mega-prompt.

Each domain prompt keeps the original's discipline: EXTREME conciseness
(15-word limits), exact item counts, JSON-only output. The LLM is the writer:
it produces strings the heuristics can't. Jev stays the decider.

Active only when HELIX_MODEL_GATEWAY_URL is set (OpenAI-compatible
/v1/chat/completions). Otherwise agents run the heuristic skills and this
module is never called.

DeepSeek is the default writer: set HELIX_MODEL_GATEWAY_URL to
https://api.deepseek.com/v1 and HELIX_MODEL_GATEWAY_KEY to a DeepSeek API
key (or connect the `deepseek` credential in the Secure Vault). The model
defaults to deepseek-v4-flash on deepseek.com URLs; override with
HELIX_WRITER_MODEL.
"""
from __future__ import annotations

import json
import os
import urllib.request

_STRATEGIST = ("Act as a world-class brand strategist. CRITICAL: BE EXTREMELY "
               "CONCISE. Limit every description to 15 words. "
               "Respond with JSON only, exactly matching the requested shape. "
               "Use ONLY facts present in the provided page text. "
               "If a field cannot be grounded in the text, use null or []. "
               "NEVER invent competitor names, colors, or facts.")

PROMPTS: dict[str, dict] = {
    "voice": {
        "system": _STRATEGIST,
        "user": ("Page text:\n{TEXT}\n\nExtract voice:\n"
                 "{{\n"
                 '  "tone": ["exactly 4 adjectives"],\n'
                 '  "personality": "concise sketch, max 15 words",\n'
                 '  "description": "how the business sounds, max 15 words",\n'
                 '  "donts": ["exactly 3 things this voice would never say/do"],\n'
                 '  "sonic": {{"voiceType": "...", "musicGenre": "...", "soundKeywords": ["exactly 3"]}} '
                 "(null fields if the site gives no sonic evidence)\n"
                 "}}"),
        "fields": ["voice.tone", "voice.personality", "voice.description",
                   "voice.donts", "voice.sonic"],
    },
    "strategy": {
        "system": _STRATEGIST,
        "user": ("Page text:\n{TEXT}\n\nExtract strategy:\n"
                 "{{\n"
                 '  "positioning": "one line: how this business stands against alternatives",\n'
                 '  "keyMessaging": ["exactly 3 messages the business repeats"],\n'
                 '  "personas": [{{"name": "...", "role": "...", '
                 '"painPoints": ["exactly 3"]}}] (exactly 2 personas),\n'
                 '  "swot": {{"strengths": ["exactly 2"], "weaknesses": ["exactly 2"], '
                 '"opportunities": ["exactly 2"], "threats": ["exactly 2"]}},\n'
                 '  "competitors": ["names ONLY, and ONLY if named or linked on the site"]\n'
                 "}}"),
        "fields": ["strategy.positioning", "strategy.key_messaging",
                   "customers.personas", "strategy.swot", "competitors"],
    },
    "visual_style": {
        "system": _STRATEGIST + " Measured facts are provided below — interpret style from them, never invent new ones.",
        "user": ("Measured from the site's real CSS — these are FACTS, do not change them:\n"
                 "Colors: {COLORS}\nFonts: {FONTS}\n\n"
                 "Page text:\n{TEXT}\n\nInterpret visual style:\n"
                 "{{\n"
                 '  "styleKeywords": ["exactly 3"],\n'
                 '  "designSystem": "max 15 words",\n'
                 '  "imageStyle": "max 15 words, or null"\n'
                 "}}"),
        "fields": ["visual.style_keywords", "visual.design_system", "visual.image_style"],
    },
}

_MAX_TEXT = 6000


def _writer_model(url: str) -> str:
    explicit = os.environ.get("HELIX_WRITER_MODEL")
    if explicit:
        return explicit
    if "deepseek.com" in url:
        return "deepseek-v4-flash"
    return "writer"


_DEEPSEEK_URL = "https://api.deepseek.com/v1"
_DEEPSEEK_CREDENTIAL = "custom.deepseek"
_CREDS_HELPER_PATH = "/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py"

_vault_probe: bool | None = None


def _creds_helper():
    """Lazy import of the Secure Vault surrogate helper."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "dynamic_credentials", _CREDS_HELPER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _vault_available() -> bool:
    """Cached probe: is the DeepSeek vault credential present?"""
    global _vault_probe
    if _vault_probe is not None:
        return _vault_probe
    try:
        helper = _creds_helper()
        helper.dynamic_credential_entry(_DEEPSEEK_CREDENTIAL)
        _vault_probe = True
    except Exception:
        _vault_probe = False
    return _vault_probe


def _gateway_url() -> str | None:
    """Explicit env URL wins; otherwise the connected DeepSeek credential
    supplies its default endpoint."""
    url = os.environ.get("HELIX_MODEL_GATEWAY_URL")
    if url:
        return url
    if _vault_available():
        return _DEEPSEEK_URL
    return None


def _apply_auth(req) -> bool:
    """Attach auth to the request. Explicit env key wins; otherwise use the
    Secure Vault surrogate. Returns False when no auth is available."""
    key = os.environ.get("HELIX_MODEL_GATEWAY_KEY")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
        return True
    try:
        helper = _creds_helper()
        helper.add_surrogate_to_request(
            req, _DEEPSEEK_CREDENTIAL, allowed_hosts=["api.deepseek.com"])
        return True
    except Exception:
        return False


def llm_extract(domain: str, text: str, extra: dict | None = None) -> dict:
    """Run one per-agent strategist prompt. Returns {} when unconfigured or on failure."""
    spec = PROMPTS.get(domain)
    url = _gateway_url()
    if not url or not spec:
        return {}
    user = spec["user"].replace("{TEXT}", text[:_MAX_TEXT])
    for k, v in (extra or {}).items():
        user = user.replace("{" + k.upper() + "}", str(v))
    body = {
        "model": _writer_model(url),
        "messages": [
            {"role": "system", "content": spec["system"]},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"})
        if not _apply_auth(req):
            return {}
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
        return json.loads(resp["choices"][0]["message"]["content"])
    except Exception:
        return {}


def llm_configured() -> bool:
    return _gateway_url() is not None
