"""extractor:documents — owns policies + faq pages.

Source of policies (returns/shipping/privacy), mission/values (about pages),
and the RAG knowledge manifest."""
import re

from agents.base import ExtractorAgent, Finding
from agents.crawl import pages_for_agent
from agents.fetcher import fetch
from skills._util import visible_text


class DocumentsExtractor(ExtractorAgent):
    profile_name = "extractor_documents"

    def run(self, ctx: dict) -> list[Finding]:
        plan = ctx.get("crawl_plan") or {}
        urls = pages_for_agent(plan, self.name) if plan else []
        if not urls:
            self.think("Crawl plan gave me no policy/FAQ pages; falling back to homepage links.")
            got = fetch(ctx["url"])
            if got:
                from agents.fetcher import internal_links
                urls = internal_links(got[0], got[1], limit=6)
            else:
                return []
        self.think(f"Owning {len(urls)} document pages: policies, terms, FAQs.")

        pages: dict[str, str] = {}
        for u in urls[:8]:
            got = fetch(u)
            if got:
                pages[got[0]] = got[1]
        if not pages:
            return []

        findings = self.act("policies", {"pages": pages})

        # mission / values: heuristic sentence mining on about-ish pages
        self.think("Mining about pages for mission and values statements.")
        for url, html in pages.items():
            if not re.search(r"about|mission|values|story", url, re.I):
                continue
            text = visible_text(html)
            for m in re.finditer(
                    r"([^.]{10,200}?\bmission\b[^.]{0,200}\.)", text, re.I):
                s = m.group(1).strip()
                if len(s) > 30:
                    findings.append(self.finding("identity.mission", s[:300], 0.6, [url]))
                    break
            vals = re.findall(
                r"(?:our values|we value|we believe in)[:\s]*([^.]{10,160})\.", text, re.I)
            if vals:
                split = [v.strip(" .") for v in re.split(r"[,;•]", vals[0]) if len(v.strip()) > 2]
                if split:
                    findings.append(self.finding("identity.values", split[:6], 0.55, [url]))
        self.memory.write("docs", list(pages))
        return findings
