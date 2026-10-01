"""Model gateway — Jev is the decider, the LLM is the writer.

TypeSafe AI's Jev ("System One Model", https://docs.typesafe.ai):
  POST https://api.typesafe.ai/v1/systemone, Bearer TYPESAFE_API_KEY
  { model: "jev-latest", state, questions: { id: Question } }
  -> { model, answers: { id: { type, choice, probabilities, confidence } },
       usage: { input_tokens, output_tokens } }
Question types: choice (criteria {option: description}), score (criteria
[ordered levels]), noul (yes/no claim). $0.042/MTok input, output free,
70-500ms. Early access — we are not in it yet.

Architecture: every decision in the mutation pipeline goes through
decide(). Provider chain: Jev -> LLM fallback (cheap model, structured
output, via HELIX_MODEL_GATEWAY_URL) -> deterministic heuristic. The
heuristic is always available, so the pipeline runs with zero keys; the
Decision records which provider actually decided, and that becomes the
audit trail on proposals and receipts.

Jev is the decider, never the writer: it cannot generate strings, so
extraction and prompt compilation stay on the LLM/heuristics.
"""
import json
import os
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = os.environ.get("JEV_MODEL", "jev-latest")
JEV_PRICE_PER_MTOK = 0.042
JEV_TIMEOUT_S = 10

AUTO_APPLY_CONFIDENCE = 0.7   # Jev must clear this for auto-apply
ESCALATE_CONFIDENCE = 0.5     # below this, Jev's answer is not trusted


@dataclass
class Decision:
    question_id: str
    decision: object            # choice key | score float | bool
    probabilities: dict = field(default_factory=dict)
    confidence: float = 0.0
    provider: str = "heuristic"  # jev | llm | heuristic
    latency_ms: float = 0.0
    cost_usd: float = 0.0
    fallback_reason: str | None = None

    def trail(self) -> dict:
        return {"question": self.question_id, "provider": self.provider,
                "decision": self.decision, "confidence": round(self.confidence, 3),
                "probabilities": {k: round(v, 3) for k, v in self.probabilities.items()},
                "cost_usd": round(self.cost_usd, 6),
                "latency_ms": round(self.latency_ms, 1),
                "fallback_reason": self.fallback_reason}


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _jev_call(question_id: str, qtype: str, instructions: str,
              criteria, state) -> Decision:
    """One Jev call. Raises on any failure so the caller falls through."""
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise RuntimeError("TYPESAFE_API_KEY not set (Jev early access pending)")
    body = {"model": JEV_MODEL, "state": state,
            "questions": {question_id: {"type": qtype, "instructions": instructions,
                                        "criteria": criteria}}}
    payload = json.dumps(body).encode()
    t0 = time.time()
    last_err = None
    for attempt in range(3):  # 2 retries, backoff on 408/429/5xx
        req = urllib.request.Request(
            JEV_ENDPOINT, data=payload,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=JEV_TIMEOUT_S) as r:
                resp = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            retry_after = e.headers.get("Retry-After") if e.headers else None
            if e.code in (408, 429, 529) or 500 <= e.code < 600:
                time.sleep(float(retry_after) if retry_after else min(0.5 * 2 ** attempt, 5))
                continue
            raise RuntimeError(f"Jev HTTP {e.code} (not retryable)")
    else:
        raise RuntimeError(f"Jev request failed after retries: {last_err}")
    latency = (time.time() - t0) * 1000
    ans = resp["answers"][question_id]
    usage = resp.get("usage", {})
    cost = usage.get("input_tokens", _estimate_tokens(payload.decode())) / 1e6 * JEV_PRICE_PER_MTOK
    if qtype == "choice":
        return Decision(question_id, ans["choice"],
                        probabilities=ans.get("probabilities", {}),
                        confidence=ans.get("confidence", 0.0),
                        provider="jev", latency_ms=latency, cost_usd=cost)
    if qtype == "score":
        score = ans.get("score", 0.5)
        score = max(0.0, min(1.0, float(score)))
        return Decision(question_id, score,
                        probabilities=ans.get("probabilities", {}),
                        confidence=ans.get("confidence", 0.0),
                        provider="jev", latency_ms=latency, cost_usd=cost)
    # noul
    raw = ans.get("noul", False)
    val = bool(raw) if isinstance(raw, bool) else float(raw) >= 0.5
    conf = float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0.8
    return Decision(question_id, val, confidence=conf,
                    provider="jev", latency_ms=latency, cost_usd=cost)


def _llm_call(question_id: str, qtype: str, instructions: str,
              criteria, state, heuristic) -> Decision:
    """Cheap-model structured-output fallback. Unconfigured -> heuristic."""
    url = os.environ.get("HELIX_MODEL_GATEWAY_URL")
    if not url:
        raise RuntimeError("HELIX_MODEL_GATEWAY_URL not set")
    schema: dict = {"type": "object",
                    "properties": {"decision": {}, "confidence": {"type": "number"}},
                    "required": ["decision", "confidence"]}
    if qtype == "choice":
        schema["properties"]["decision"] = {"type": "string", "enum": list(criteria)}
    elif qtype == "score":
        schema["properties"]["decision"] = {"type": "number", "minimum": 0, "maximum": 1}
    else:
        schema["properties"]["decision"] = {"type": "boolean"}
    body = {"model": os.environ.get("HELIX_CHEAP_MODEL", "cheap"),
            "messages": [
                {"role": "system",
                 "content": instructions + " Answer with JSON only, matching the schema."},
                {"role": "user", "content": json.dumps(
                    {"state": state, "criteria": criteria, "question": question_id})}],
            "response_format": {"type": "json_schema", "json_schema": schema}}
    t0 = time.time()
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
        out = json.loads(resp["choices"][0]["message"]["content"])
    except Exception as e:
        raise RuntimeError(f"LLM fallback failed: {e}")
    latency = (time.time() - t0) * 1000
    return Decision(question_id, out["decision"], confidence=float(out.get("confidence", 0.5)),
                    provider="llm", latency_ms=latency, cost_usd=0.001,
                    fallback_reason="jev unavailable")


def decide(question_id: str, qtype: str, instructions: str, criteria,
           state, heuristic) -> Decision:
    """Jev is the decider; LLM then heuristic are the fallbacks.

    heuristic: zero-arg callable returning a Decision with provider="heuristic".
    Every path returns a Decision; the provider field is the audit trail.
    """
    try:
        return _jev_call(question_id, qtype, instructions, criteria, state)
    except Exception as jev_err:
        try:
            d = _llm_call(question_id, qtype, instructions, criteria, state, heuristic)
            d.fallback_reason = f"jev: {jev_err}"
            return d
        except Exception as llm_err:
            d = heuristic()
            d.fallback_reason = f"jev: {jev_err}; llm: {llm_err}"
            return d


def jev_status() -> dict:
    """One-line status for demos and diagnostics."""
    key = os.environ.get("TYPESAFE_API_KEY")
    return {"provider": "jev" if key else "heuristic",
            "jev_configured": bool(key),
            "jev_model": JEV_MODEL,
            "jev_endpoint": JEV_ENDPOINT,
            "llm_fallback_configured": bool(os.environ.get("HELIX_MODEL_GATEWAY_URL")),
            "note": ("Jev early access pending — decisions fall back to "
                     "deterministic heuristics until TYPESAFE_API_KEY is set.")
            if not key else "Jev live"}


# ---------------------------------------------------------------------------
# Music-model provider slot — sonic logo + UI sounds.
#
# Interface (documented; stub until a key exists):
#   generate_music(prompt, duration_s, out_path, kind="sonic_logo") -> dict
#     {asset_path, model, prompt, duration_s}
# Raises MusicProviderStubbed when FAL_API_KEY is unset. The sonic_brand skill
# ALWAYS produces the brief + structured generation prompt first, so setting
# FAL_API_KEY later and re-running produces audio with no code changes.
#
# Sacred Core pattern: provider key passed through to the call, empty when
# unconfigured (cf. Sacred-core videoService: keys.fal || ''). Here the empty
# case raises a documented stub error instead of attempting the call.
# ---------------------------------------------------------------------------

class MusicProviderStubbed(RuntimeError):
    """Raised when the music model is called without FAL_API_KEY."""


MUSIC_MODEL = os.environ.get("HELIX_MUSIC_MODEL", "fal-ai/stable-audio")
MUSIC_TIMEOUT_S = 120


def music_status() -> dict:
    key = os.environ.get("FAL_API_KEY")
    return {"provider": "fal" if key else "stub",
            "model": MUSIC_MODEL,
            "endpoint": f"https://fal.run/{MUSIC_MODEL}",
            "configured": bool(key),
            "note": ("Set FAL_API_KEY to generate sonic logos and UI sounds; "
                     "until then the sonic_brand skill stages briefs + prompts.")
            if not key else "Music model live"}


def generate_music(prompt: str, duration_s: float, out_path: str,
                   kind: str = "sonic_logo") -> dict:
    """Generate `duration_s` seconds of audio from a structured prompt.

    fal.ai queue API: POST https://fal.run/<model> with `Key <FAL_API_KEY>`
    auth, poll the status_url, download the audio from the response_url.
    NOTE: the exact input/output schema is model-specific — verify the
    `input` mapping against the fal.ai docs for HELIX_MUSIC_MODEL before
    trusting a keyed run end to end. The stub path (no key) is the
    exercised path today.
    """
    key = os.environ.get("FAL_API_KEY")
    if not key:
        raise MusicProviderStubbed(
            "FAL_API_KEY not set — sonic logo and UI sounds stay as staged "
            "briefs. Set FAL_API_KEY and re-run the sonic_brand skill; "
            "no code changes needed.")
    import urllib.request as _req
    submit = _req.Request(
        f"https://fal.run/{MUSIC_MODEL}",
        data=json.dumps({"input": {"prompt": prompt,
                                   "seconds_total": duration_s,
                                   "kind": kind}}).encode(),
        headers={"Authorization": f"Key {key}", "Content-Type": "application/json"})
    t0 = time.time()
    with _req.urlopen(submit, timeout=30) as r:
        job = json.loads(r.read())
    status_url = job.get("status_url")
    response_url = job.get("response_url")
    audio_url = None
    while time.time() - t0 < MUSIC_TIMEOUT_S:
        with _req.urlopen(_req.Request(
                status_url, headers={"Authorization": f"Key {key}"}),
                timeout=30) as r:
            st = json.loads(r.read())
        if st.get("status") in ("COMPLETED", "completed"):
            with _req.urlopen(_req.Request(
                    response_url, headers={"Authorization": f"Key {key}"}),
                    timeout=30) as r:
                payload = json.loads(r.read())
            # model-specific output shape — adapt to the chosen model's docs
            audio_url = (payload.get("audio", {}) or {}).get("url") or payload.get("audio_url")
            break
        if st.get("status") in ("FAILED", "failed"):
            raise RuntimeError(f"music model job failed: {st}")
        time.sleep(3)
    if not audio_url:
        raise RuntimeError("music model job timed out without an audio URL")
    with _req.urlopen(audio_url, timeout=60) as r:
        data = r.read()
    with open(out_path, "wb") as f:
        f.write(data)
    return {"asset_path": out_path, "model": MUSIC_MODEL,
            "prompt": prompt, "duration_s": duration_s,
            "latency_ms": round((time.time() - t0) * 1000, 1)}
