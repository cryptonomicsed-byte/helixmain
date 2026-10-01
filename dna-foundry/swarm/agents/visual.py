"""extractor:visual — the art director. Measures, never guesses.

Runs visual_css on owned pages: parses real stylesheets for the measured
palette (top colors by frequency) and observed font families. The LLM
(visual_style prompt) only interprets style keywords/design system from
those measured facts — it never invents a hex code. This is the direct
fix for Sacred Core's guess-the-hex weakness.
"""
from agents.base import ExtractorAgent
from agents.crawl import pages_for_agent
from agents.fetcher import fetch
from llm_extract import llm_extract, llm_configured
from skills._util import visible_text


class VisualExtractor(ExtractorAgent):
    profile_name = "extractor_visual"

    def run(self, ctx: dict) -> list:
        plan = ctx.get("crawl_plan") or {}
        urls = pages_for_agent(plan, self.name) if plan else []
        if not urls:
            urls = [ctx["url"]]
        self.think(f"Measuring visual identity from {len(urls)} pages' real CSS.")

        pages: dict[str, str] = {}
        for u in urls[:5]:
            got = fetch(u)
            if got:
                pages[got[0]] = got[1]
        if not pages:
            return []

        findings = self.act("visual_css", {"pages": pages})
        measured = {f.field: f.value for f in findings
                    if f.field.startswith("visual.")}

        if llm_configured() and measured:
            self.think("Gateway configured — LLM interprets style FROM the measured facts.")
            blob = visible_text(next(iter(pages.values())))[:3000]
            data = llm_extract("visual_style", blob, extra={
                "COLORS": ", ".join(str(v) for k, v in measured.items() if "color" in k),
                "FONTS": str(measured.get("visual.font_pairing", "")),
            })
            if data.get("styleKeywords"):
                findings.append(self.finding("visual.style_keywords", data["styleKeywords"][:3], 0.7, list(pages)))
            if data.get("designSystem"):
                findings.append(self.finding("visual.design_system", data["designSystem"][:120], 0.7, list(pages)))
            if data.get("imageStyle"):
                findings.append(self.finding("visual.image_style", data["imageStyle"][:120], 0.65, list(pages)))
        else:
            self.think("Style interpretation needs the gateway; measured colors/fonts stand alone.")
            # heuristic style keywords from palette warmth
            prim = measured.get("visual.primary_color", "")
            if prim:
                try:
                    r, g, b = int(prim[1:3], 16), int(prim[3:5], 16), int(prim[5:7], 16)
                    warm = r > b + 20
                    kw = ["warm", "earthy", "approachable"] if warm else ["cool", "crisp", "modern"]
                    findings.append(self.finding("visual.style_keywords", kw, 0.45, list(pages)))
                except (ValueError, IndexError):
                    pass
        return findings
