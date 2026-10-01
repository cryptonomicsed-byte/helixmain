"""extractor:reviews — owns reviews/testimonials pages.

Mines on-site testimonial content for sample phrases (the voice skill's
best raw material: customers' own words) and sentiment themes the owner
may not have noticed. Third-party review APIs need keys; this agent is
honest about that and records it as an insight."""
from agents.base import ExtractorAgent, Finding
from agents.crawl import pages_for_agent
from agents.fetcher import fetch


class ReviewsExtractor(ExtractorAgent):
    profile_name = "extractor_reviews"

    def run(self, ctx: dict) -> list[Finding]:
        plan = ctx.get("crawl_plan") or {}
        urls = pages_for_agent(plan, self.name) if plan else []
        if not urls:
            self.think("No review pages in the crawl plan; checking the homepage for testimonial blurbs.")
            urls = [ctx["url"]]
        self.think(f"Owning {len(urls)} review pages. Customers' words become sample phrases.")

        pages: dict[str, str] = {}
        for u in urls[:4]:
            got = fetch(u)
            if got:
                pages[got[0]] = got[1]

        self.think("Looking for testimonial/review sections — on-site first, "
                   "third-party review APIs need keys I don't have.")
        findings = self.act("testimonials", {"pages": pages})
        if not findings:
            self.think("No review corpus found. Recording that honestly as an "
                       "insight instead of inventing sentiment.")
            home = plan.get("home") if plan else ctx["url"]
            findings.append(self.finding("insights", {
                "title": "No review corpus detected",
                "detail": ("No testimonials or reviews were found on the site. "
                           "Customer-sentiment insights will be thin until reviews "
                           "are collected or a review platform is connected."),
                "evidence": [home],
            }, 0.9, [home]))
        return findings
