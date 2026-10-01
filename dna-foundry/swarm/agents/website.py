"""extractor:website — first contact. Owns home + about pages.

Fetches owned pages, runs identity/voice/offerings skills, detects the
platform (systems), and hands the crawl plan's document links to the swarm.
Also upgrades voice via the per-agent LLM prompt when the gateway is set.
"""
from agents.base import ExtractorAgent, Finding
from agents.crawl import pages_for_agent
from agents.fetcher import fetch
from llm_extract import llm_extract, llm_configured
from skills._util import visible_text


class WebsiteExtractor(ExtractorAgent):
    profile_name = "extractor_website"

    def run(self, ctx: dict) -> list[Finding]:
        plan = ctx.get("crawl_plan") or {}
        urls = pages_for_agent(plan, self.name) if plan else [ctx["url"]]
        self.think(f"Owning {len(urls)} pages (home + about). Identity comes from the owner's own words.")

        pages: dict[str, str] = {}
        for u in urls[:3]:
            got = fetch(u)
            if got:
                pages[got[0]] = got[1]
        if not pages:
            self.think(f"Fetch failed for {urls}; recording nothing, flagging to orchestrator.")
            self.send("orchestrator", "fetch_failed", {"urls": urls})
            return []
        home_url = next(iter(pages))
        home_html = pages[home_url]
        self.memory.write("homepage_url", home_url)
        ctx["business_name"] = ctx.get("business_name")  # filled by orchestrator post-merge? no — read from meta below
        page_ctx = {"html": home_html, "url": home_url}

        findings: list[Finding] = []
        self.think("Meta tags carry the owner's own words for name/tagline — highest authority.")
        findings += self.act("meta_tags", page_ctx)
        for f in findings:
            if f.field == "identity.name":
                ctx["business_name"] = f.value

        tagline_known = any(f.field == "identity.tagline" for f in findings)
        self.think("Headings reveal how the business structures its offerings; h1 doubles as a tagline fallback.")
        findings += self.act("headings", {**page_ctx, "has_tagline": tagline_known})

        self.think("Contact block, hours, and platform fingerprints ground operations in facts.")
        findings += self.act("contact_info", page_ctx)
        findings += self.act("hours_patterns", page_ctx)
        findings += self.act("systems_detect", page_ctx)

        self.think("Word choice across owned pages is the cheapest honest signal of voice.")
        findings += self.act("tone", {**page_ctx,
                                      "html_all": list(pages.values())})
        tones = []
        for f in findings:
            if f.field == "voice.tone":
                tones = f.value
        findings += self.act("voice_enrich", {**page_ctx, "tones": tones})
        findings += self.act("offerings", page_ctx)
        findings += self.act("pricing", {"pages": pages})

        if llm_configured():
            self.think("Gateway configured — running the per-agent voice prompt.")
            blob = "\n\n".join(visible_text(h)[:2500] for h in list(pages.values())[:3])
            data = llm_extract("voice", blob)
            if isinstance(data.get("tone"), list) and data["tone"]:
                findings.append(self.finding("voice.tone", data["tone"][:4], 0.8, list(pages)))
            for fld, key, mx in (("voice.personality", "personality", 120),
                                 ("voice.description", "description", 120)):
                if data.get(key):
                    findings.append(self.finding(fld, str(data[key])[:mx], 0.75, list(pages)))
            if isinstance(data.get("donts"), list) and data["donts"]:
                findings.append(self.finding("voice.donts", data["donts"][:3], 0.75, list(pages)))
            sonic = data.get("sonic")
            if isinstance(sonic, dict) and any(sonic.values()):
                findings.append(self.finding("voice.sonic", {
                    "voice_type": sonic.get("voiceType"),
                    "music_genre": sonic.get("musicGenre"),
                    "sound_keywords": (sonic.get("soundKeywords") or [])[:3],
                }, 0.7, list(pages)))

        self.think("Handing page buckets to the rest of the swarm via A2A.")
        self.send("broadcast", "crawl_plan", {"buckets": plan.get("buckets", {}),
                                             "home": plan.get("home")})
        self.memory.write("pages", list(pages))
        return findings
