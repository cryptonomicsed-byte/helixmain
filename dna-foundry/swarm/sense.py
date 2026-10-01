"""Sense: tiered, cost-efficient re-crawl loop for the mutation protocol.

The card mutates with the company, but re-crawling everything on a fixed
cron is how you burn $500/mo on a 100-business fleet. Sense is a tiered
pipeline where expensive work almost never runs:

  Tier 0 — change detection (near-free, every cycle): conditional HTTP
           (ETag / If-Modified-Since / HEAD) + sitemap.xml lastmod +
           SHA-256 of fetched HTML vs stored hash. No change -> stop.
           Cost ~$0.0001. No browser render, no LLM.
  Tier 1 — cheap triage (only on change): Jev, the System One decider,
           classifies the diff (hours | offering | redesign | new_content |
           noise) with calibrated confidence; below 0.5 it escalates to Tier 2
           instead of guessing. Deterministic heuristics are the fallback
           provider until Jev early access lands (TYPESAFE_API_KEY).
  Tier 2 — targeted extraction (only on material change): extractor
           skills run ONLY on changed pages/sections -> dna.propose_change.
  Tier 3 — full re-extract (rare): redesign signals -> orchestrator run.

Adaptive cadence (the biggest saver): per-site volatility score in the
sidecar. Start weekly; back off toward monthly after 3 unchanged cycles;
speed up toward daily when changes land. A plumber whose site hasn't
changed in 2 years must not cost the same as a cafe with a weekly menu.

Rules honored here:
  - raw HTML + readability-lite for ~95% of SMB sites (WordPress /
    Squarespace / Wix). Headless render ONLY for JS-heavy sites, detected
    once and cached as a per-site `js_render` flag.
  - NEVER a paid crawl API in the hot loop — self-hosted urllib fetch.
  - The scheduler (cron/heartbeat) invokes this; sense never schedules itself.

State lives in a sidecar (swarm/sense-state/<org>.json), not in the card:
volatility is platform bookkeeping, not business content.

Usage: python3 sense.py --org org_demo0001 [--force]
"""
import argparse
import difflib
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

SWARM = Path(__file__).parent
FOUNDRY = SWARM.parent
STATE_DIR = SWARM / "sense-state"

sys.path.insert(0, str(SWARM))
from mutate import latest_card, propose_change  # noqa: E402

# --- tier cost estimates (USD), documented in docs/crawl-cost-model.md -------
COST_T0 = 0.0001
COST_T1_HEURISTIC = 0.001
COST_T1_LLM = 0.005
COST_T2 = 0.10
COST_T3 = 0.50

UNCHANGED_BACKOFF_AFTER = 3   # cycles
INTERVAL_MIN_DAYS = 1
INTERVAL_MAX_DAYS = 30
INTERVAL_START_DAYS = 7


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- sidecar state ----------------------------------------------------------
def load_state(org: str) -> dict:
    STATE_DIR.mkdir(exist_ok=True)
    p = STATE_DIR / f"{org}.json"
    if p.exists():
        return json.loads(p.read_text())
    return {"org": org, "sites": {}}


def save_state(state: dict) -> None:
    (STATE_DIR / f"{state['org']}.json").write_text(json.dumps(state, indent=2))


def site_state(state: dict, url: str) -> dict:
    return state["sites"].setdefault(url, {
        "interval_days": INTERVAL_START_DAYS,
        "consecutive_unchanged": 0,
        "volatility": 0.5,
        "last_run": None,
        "etag": None,
        "last_modified": None,
        "html_hash": None,
        "text": None,
        "sitemap_lastmod": None,
        "js_render": False,
    })


# --- Tier 0: change detection ------------------------------------------------
def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def fetch_bytes(url: str, etag: str | None, last_mod: str | None) -> tuple[bytes | None, dict]:
    """Conditional GET. Returns (body_or_None, headers). None body + 304-safe."""
    if url.startswith("file://"):
        data = Path(url[7:]).read_bytes()
        return data, {}
    req = urllib.request.Request(url, headers={"User-Agent": "HelixMain-sense/0.1"})
    if etag:
        req.add_header("If-None-Match", etag)
    if last_mod:
        req.add_header("If-Modified-Since", last_mod)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None, dict(e.headers)
        raise


def sitemap_lastmod(page_url: str) -> str | None:
    """Cheapest signal of all: the sitemap's <lastmod> for this page."""
    try:
        if page_url.startswith("file://"):
            return None
        m = re.match(r"(https?://[^/]+)", page_url)
        sm_url = m.group(1) + "/sitemap.xml"
        with urllib.request.urlopen(
                urllib.request.Request(sm_url, headers={"User-Agent": "HelixMain-sense/0.1"}),
                timeout=15) as r:
            root = ET.fromstring(r.read())
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        for u in root.findall("s:url", ns):
            loc = (u.findtext("s:loc", namespaces=ns) or "").rstrip("/")
            if loc == page_url.rstrip("/"):
                return u.findtext("s:lastmod", namespaces=ns)
    except Exception:
        pass
    return None


def tier0_changed(url: str, st: dict) -> tuple[bool, str, dict, bytes | None]:
    """Returns (changed, reason, headers, body_or_None). Near-free."""
    # 1. sitemap lastmod early-out (one tiny XML fetch)
    lm = sitemap_lastmod(url)
    if lm and st.get("sitemap_lastmod") and lm <= st["sitemap_lastmod"]:
        return False, "sitemap lastmod unchanged", {}, None
    # 2. conditional GET (304 = unchanged, headers only)
    body, headers = fetch_bytes(url, st.get("etag"), st.get("last_modified"))
    if body is None:
        return False, "HTTP 304 (ETag/Last-Modified match)", headers, None
    # 3. content hash
    h = sha256_bytes(body)
    if st.get("html_hash") and h == st["html_hash"]:
        return False, "SHA-256 of HTML unchanged", headers, body
    return True, "content hash differs", headers, body


# --- Tier 1: cheap triage ----------------------------------------------------
def readability_lite(html: bytes) -> str:
    """Readability for the 95%: strip chrome, keep the content text."""
    text = html.decode("utf-8", errors="replace")
    text = re.sub(r"(?is)<(script|style|nav|header|footer|aside)[^>]*>.*?</\1>", " ", text)
    m = re.search(r"(?is)<(main|article)[^>]*>(.*?)</\1>", text)
    if m:
        text = m.group(2)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


_HOURS = re.compile(
    r"(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|"
    r"Sat(?:urday)?|Sun(?:day)?)\s*[–\-to]*\s*(?:Mon(?:day)?|Tue(?:sday)?|"
    r"Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?"
    r"\s*:?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[–\-to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)",
    re.I)


def _triage_heuristic(url: str, old_text: str | None,
                      new_text: str) -> tuple[str, str, float, str]:
    """Heuristic triage. Returns (class, reason, similarity, changed_blob)."""
    if not old_text:
        return "new_content", "no text baseline; first deep look", 0.0, ""
    sm = difflib.SequenceMatcher(None, old_text, new_text)
    ratio = sm.ratio()
    old_lines = old_text.split(". ")
    new_lines = new_text.split(". ")
    diff = list(difflib.unified_diff(old_lines, new_lines, n=0))
    added = [l[1:] for l in diff if l.startswith("+") and not l.startswith("+++")]
    removed = [l[1:] for l in diff if l.startswith("-") and not l.startswith("---")]
    changed_blob = " ".join(added + removed)
    if _HOURS.search(changed_blob):
        return "hours", "hours-like pattern in changed text", ratio, changed_blob
    if ratio < 0.4 or len(added) + len(removed) > 0.6 * max(len(old_lines), 1):
        return "redesign", f"text similarity {ratio:.2f} — structure-level change", ratio, changed_blob
    if added and not removed and len(added) > 3:
        return "new_content", f"{len(added)} added segments, none removed", ratio, changed_blob
    if not added and not removed:
        return "noise", "hash differed but readable text identical (chrome/tracking)", ratio, changed_blob
    # Heuristics inconclusive but text really changed -> let Tier 2's targeted
    # extraction decide; its findings still pass through the proposal gate.
    if len(added) + len(removed) > 0:
        return "new_content", (f"{len(added) + len(removed)} changed segments; heuristic triage "
                               "inconclusive"), ratio, changed_blob
    return "noise", "no material text change", ratio, changed_blob


_HEURISTIC_CONF = {"hours": 0.8, "offering": 0.7, "redesign": 0.75,
                   "new_content": 0.7, "noise": 0.6}


def tier1_triage(url: str, old_text: str | None, new_text: str):
    """Tier 1: Jev is the decider (System One task: diff in, typed
    probabilistic classification out). Heuristic is the fallback provider.

    Returns (class, Decision). class in {hours, new_content, redesign, minor}.
    """
    from model_gateway import decide, Decision, ESCALATE_CONFIDENCE
    cls, reason, ratio, changed_blob = _triage_heuristic(url, old_text, new_text)

    def heuristic() -> Decision:
        return Decision("triage", cls,
                        probabilities={cls: _HEURISTIC_CONF[cls]},
                        confidence=_HEURISTIC_CONF[cls],
                        provider="heuristic", cost_usd=COST_T1_HEURISTIC,
                        fallback_reason=reason)

    state = {"page_url": url,
             "text_before": (old_text or "")[:4000],
             "text_after": new_text[:4000],
             "changed_segments": changed_blob[:2000],
             "similarity": round(ratio, 3),
             "heuristic_prior": cls}
    d = decide("triage", "choice",
               "Classify what materially changed on this small-business webpage. "
               "Return the single best-fitting class.",
               {"hours": "operating hours / opening times changed",
                "offering": "products, services or menu items changed",
                "redesign": "page structure, layout or design overhauled",
                "new_content": "new substantive business content added",
                "noise": "no material business change (site chrome, tracking, trivial text)"},
               state, heuristic)
    if d.provider == "jev" and d.confidence < ESCALATE_CONFIDENCE:
        # Jev isn't sure -> safe default: run Tier 2, the proposal gate governs.
        d = Decision("triage", "new_content",
                     probabilities=d.probabilities, confidence=d.confidence,
                     provider="jev", latency_ms=d.latency_ms, cost_usd=d.cost_usd,
                     fallback_reason=f"jev confidence {d.confidence:.2f} < {ESCALATE_CONFIDENCE}: "
                                     "escalated to targeted extraction")
        return "new_content", d
    mapping = {"hours": "hours", "offering": "new_content", "redesign": "redesign",
               "new_content": "new_content", "noise": "minor"}
    return mapping.get(str(d.decision), "new_content"), d


# --- Tier 2: targeted extraction ----------------------------------------------
# A changed page can't be read in isolation (the card's hours may join
# matches from several pages), so Tier 2 re-runs the skill over the union
# of the field's known provenance pages — still cheap, no new discovery.
_FIELD_SKILLS = {"operations.hours": "hours_patterns", "offerings": "offerings"}


def tier2_extract(changed_url: str, card: dict) -> list[dict]:
    """Run extractor skills ONLY on pages already backing the affected
    fields. Findings become dna.propose_change proposals."""
    from skills import hours_patterns, offerings
    skills = {"hours_patterns": hours_patterns, "offerings": offerings}
    proposals = []
    fields = [f for f, p in card.get("field_provenance", {}).items()
              if changed_url in p.get("sources", []) and f in _FIELD_SKILLS]
    for field in fields:
        skill = skills[_FIELD_SKILLS[field]]
        page_urls = [s for s in card["field_provenance"][field]["sources"]
                     if s.startswith("http") or s.startswith("file://")]
        if field == "operations.hours":
            seen: list[str] = []
            for u in page_urls:
                try:
                    b, _ = fetch_bytes(u, None, None)
                except Exception:
                    continue
                if not b:
                    continue
                for f in skill.run({"html": b.decode("utf-8", errors="replace"), "url": u}):
                    for part in f.value.split("; "):
                        if part not in seen:
                            seen.append(part)
            merged = "; ".join(seen)
            current = (card.get("operations") or {}).get("hours")
            if merged and merged != current:
                proposals.append(propose_change(
                    card["id"], field, current, merged,
                    evidence=f"sense:tier2 ({changed_url})",
                    confidence=0.75))
        elif field == "offerings":
            current = card.get("offerings", [])
            names = {o.get("name") for o in current}
            fresh = []
            for u in page_urls:
                try:
                    b, _ = fetch_bytes(u, None, None)
                except Exception:
                    continue
                if not b:
                    continue
                for f in skill.run({"html": b.decode("utf-8", errors="replace"), "url": u}):
                    items = f.value if isinstance(f.value, list) else [f.value]
                    for it in items:
                        if isinstance(it, dict) and it.get("name") not in names:
                            names.add(it["name"])
                            fresh.append(it)
            if fresh:
                proposals.append(propose_change(
                    card["id"], field, current, current + fresh,
                    evidence=f"sense:tier2 ({changed_url})",
                    confidence=0.7))
    return proposals


# --- Tier 3: full re-extract ---------------------------------------------------
def tier3_reextract(url: str, org: str) -> dict:
    r = subprocess.run(
        [sys.executable, str(SWARM / "orchestrator.py"), "extract",
         "--url", url, "--org", org, "--out", str(FOUNDRY / "cards")],
        capture_output=True, text=True, cwd=str(FOUNDRY))
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr[-1000:]}
    return {"ok": True, "detail": r.stdout.strip().splitlines()[-1]}


# --- adaptive cadence ----------------------------------------------------------
def update_volatility(st: dict, changed: bool) -> None:
    if changed:
        st["consecutive_unchanged"] = 0
        st["volatility"] = min(1.0, st["volatility"] + 0.25)
        st["interval_days"] = max(INTERVAL_MIN_DAYS, st["interval_days"] / 2)
    else:
        st["consecutive_unchanged"] += 1
        st["volatility"] = max(0.0, st["volatility"] - 0.1)
        if st["consecutive_unchanged"] >= UNCHANGED_BACKOFF_AFTER:
            st["interval_days"] = min(INTERVAL_MAX_DAYS, st["interval_days"] * 2)


def is_due(st: dict, force: bool) -> bool:
    if force or not st.get("last_run"):
        return True
    nxt = datetime.fromisoformat(st["last_run"]) + timedelta(days=st["interval_days"])
    return datetime.now(timezone.utc) >= nxt


# --- main loop -----------------------------------------------------------------
def sense_site(url: str, org: str, card: dict, state: dict, force: bool) -> dict:
    st = site_state(state, url)
    report: dict = {"url": url, "tier_reached": 0, "cost_usd": 0.0, "due": is_due(st, force)}
    if not report["due"]:
        report["note"] = (f"not due (volatility {st['volatility']:.2f}, "
                          f"interval {st['interval_days']:.1f}d)")
        return report

    # TIER 0
    report["tier_reached"] = 0
    report["cost_usd"] += COST_T0
    try:
        changed, reason, headers, body = tier0_changed(url, st)
    except Exception as e:
        report["error"] = f"tier0 fetch failed: {e}"
        return report
    st["last_run"] = utcnow()
    if headers.get("ETag"):
        st["etag"] = headers["ETag"]
    if headers.get("Last-Modified"):
        st["last_modified"] = headers["Last-Modified"]
    report["tier0"] = reason
    if not changed:
        update_volatility(st, False)
        report["outcome"] = "unchanged — stop"
        report["next_interval_days"] = st["interval_days"]
        return report

    # TIER 1 (reuse the Tier 0 body — never fetch twice)
    report["tier_reached"] = 1
    if body is None:  # 304 said changed via sitemap; fetch for real
        body, _ = fetch_bytes(url, None, None)
    assert body is not None
    if st.get("html_hash") is None or sha256_bytes(body) != st.get("html_hash"):
        st["html_hash"] = sha256_bytes(body)
    # JS-heavy detection, once, cached
    lite = readability_lite(body)
    if len(lite) < 200 < len(body) / 100 and not st.get("js_render_checked"):
        st["js_render"] = True
        st["js_render_checked"] = True
        report["js_render"] = ("page looks JS-rendered; flag cached — headless "
                               "render would run at Tier 2/3 only")
    cls, triage_decision = tier1_triage(url, st.get("text"), lite)
    report["cost_usd"] += triage_decision.cost_usd
    report["tier1"] = f"{cls}: provider={triage_decision.provider} " \
                      f"decision={triage_decision.decision} " \
                      f"confidence={triage_decision.confidence:.2f}"
    report["decision_trail"] = [triage_decision.trail()]
    st["text"] = lite
    lm = sitemap_lastmod(url)
    if lm:
        st["sitemap_lastmod"] = lm
    update_volatility(st, True)
    report["next_interval_days"] = st["interval_days"]

    if cls in ("minor",):
        report["outcome"] = "no material change — stop"
        return report
    if cls == "redesign":
        # TIER 3 — rare
        report["tier_reached"] = 3
        report["cost_usd"] += COST_T3
        report["tier3"] = tier3_reextract(url, org)
        report["outcome"] = "redesign signal — full re-extract"
        return report
    # TIER 2 — targeted
    report["tier_reached"] = 2
    report["cost_usd"] += COST_T2
    proposals = tier2_extract(url, card)
    report["proposals"] = proposals
    report["outcome"] = f"targeted extraction — {len(proposals)} proposal(s)"
    return report


def sense_org(org: str, force: bool = False) -> dict:
    state = load_state(org)
    try:
        card = latest_card(org)
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}
    # sense the card's known source URLs (homepage first)
    urls: list[str] = []
    for prov in card.get("field_provenance", {}).values():
        for s in prov.get("sources", []):
            if isinstance(s, str) and (s.startswith("http") or s.startswith("file://")) and s not in urls:
                urls.append(s)
    if not urls:
        return {"ok": False, "error": "card has no fetchable source URLs in provenance"}
    reports = [sense_site(u, org, card, state, force) for u in urls[:5]]
    save_state(state)
    total = sum(r.get("cost_usd", 0) for r in reports)
    return {"ok": True, "org": org, "card_id": card["id"],
            "card_version": card["version"], "sites": reports,
            "total_cost_usd": round(total, 6)}


def main():
    ap = argparse.ArgumentParser(description="Tiered sense re-crawl")
    ap.add_argument("--org", required=True)
    ap.add_argument("--force", action="store_true", help="ignore adaptive cadence")
    args = ap.parse_args()
    print(json.dumps(sense_org(args.org, args.force), indent=2))


if __name__ == "__main__":
    main()
