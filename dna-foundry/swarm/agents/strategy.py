"""extractor:strategy — the strategist. Owns offerings/pricing/about pages.

Runs strategy_mining (heuristic floor: positioning, key messaging,
evidence-backed SWOT, personas with FAQ-mined pain points). When the model
gateway is configured, upgrades via the per-agent strategist LLM prompt —
the LLM is the writer, heuristics are the floor.
"""
from agents.base import ExtractorAgent
from agents.crawl import pages_for_agent
from agents.fetcher import fetch
from llm_extract import llm_extract, llm_configured
from skills._util import visible_text


class StrategyExtractor(ExtractorAgent):
    profile_name = "extractor_strategy"

    def run(self, ctx: dict) -> list:
        plan = ctx.get("crawl_plan") or {}
        urls = pages_for_agent(plan, self.name) if plan else []
        if not urls:
            self.think("No crawl plan; falling back to the homepage.")
            urls = [ctx["url"]]
        self.think(f"Owning {len(urls)} strategy pages: offerings, pricing, about.")

        pages: dict[str, str] = {}
        for u in urls:
            got = fetch(u)
            if got:
                pages[got[0]] = got[1]
        if not pages:
            return []
        self.send("broadcast", "pages_seen",
                  {"agent": self.name, "pages": list(pages)})

        findings = self.act("strategy_mining", {
            "pages": pages,
            "home_url": plan.get("home") if plan else None,
            "business_name": ctx.get("business_name"),
        })
        self.think(f"Heuristic mining: {len(findings)} findings. "
                   "LLM strategist prompt upgrades what heuristics can't reach.")

        if llm_configured():
            self.think("Model gateway configured — running the per-agent strategist prompt.")
            blob = "\n\n".join(
                f"--- {u} ---\n{visible_text(h)[:2500]}" for u, h in list(pages.items())[:4])
            data = llm_extract("strategy", blob)
            if data.get("positioning"):
                findings.append(self.finding("strategy.positioning", data["positioning"][:160], 0.75, list(pages)))
            if data.get("keyMessaging"):
                findings.append(self.finding("strategy.key_messaging", data["keyMessaging"][:3], 0.75, list(pages)))
            if isinstance(data.get("personas"), list) and data["personas"]:
                clean = []
                for p in data["personas"][:2]:
                    if isinstance(p, dict) and p.get("name"):
                        clean.append({"name": p["name"][:60], "role": (p.get("role") or "")[:60],
                                      "pain_points": (p.get("painPoints") or [])[:3]})
                if clean:
                    findings.append(self.finding("customers.personas", clean, 0.7, list(pages)))
            sw = data.get("swot")
            if isinstance(sw, dict) and any(sw.values()):
                clean_sw = {k: (v or [])[:2] for k, v in sw.items()
                            if k in ("strengths", "weaknesses", "opportunities", "threats")}
                if clean_sw:
                    findings.append(self.finding("strategy.swot", clean_sw, 0.7, list(pages)))
            # competitors from LLM only if named on-site (prompt enforces); merged by competitor agent
            if isinstance(data.get("competitors"), list):
                for c in data["competitors"][:5]:
                    if isinstance(c, str) and c.strip():
                        findings.append(self.finding("competitors", {"name": c.strip()[:80]}, 0.6, list(pages)))
        else:
            self.think("No model gateway — heuristic findings stand. The LLM prompt ships with the gateway milestone.")
        return findings
