"""extractor:competitor — discovers competitors from evidence, never invents.

Sources, in order:
  1. outbound links to other businesses (non-social, non-platform, non-CDN)
  2. "vs" / "alternative" page mentions ("X vs Y", "alternatives to X")
  3. (if configured) a search API — stubbed, documented

When the site yields nothing, the orchestrator falls back to
skills.competitor_inference (obvious category chains + a local stub), with
every inferred competitor explicitly marked as such. An unmarked,
hallucinated list never ships.
"""
import re
from urllib.parse import urlparse

from agents.base import ExtractorAgent
from agents.crawl import pages_for_agent
from agents.fetcher import fetch
from skills._util import links, visible_text

SOCIAL = ("facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
          "tiktok.com", "youtube.com", "pinterest.com")
PLATFORM = ("shopify", "google.", "apple.com", "stripe.com", "paypal.com",
            "klaviyo", "mailchimp", "yelp.com", "tripadvisor",
            # online-ordering / reservation vendors — the business's own
            # sales channel, never a competitor
            "bringdat", "toasttab", "toast.", "slice", "doordash",
            "ubereats", "grubhub", "chownow", "menufy", "olo.", "olo.com",
            "singleplatform", "opentable", "resy.com", "square.site",
            "squarespace", "wix.com", "webflow")
# link labels that are calls-to-action, not business mentions
CTA_LABEL = re.compile(r"^(order|book|reserve|reservation|menu|menus|"
                       r"get directions|directions|call|call now)\b", re.I)


def _own_domain(url: str) -> str:
    d = urlparse(url).netloc.lower()
    return d[4:] if d.startswith("www.") else d


def _name_from_domain(domain: str) -> str:
    base = domain.split(".")[0]
    return re.sub(r"[-_]+", " ", base).title()


class CompetitorExtractor(ExtractorAgent):
    profile_name = "extractor_competitor"

    def run(self, ctx: dict) -> list:
        plan = ctx.get("crawl_plan") or {}
        urls = pages_for_agent(plan, self.name) if plan else []
        if not urls:
            urls = [ctx["url"]]
        own = _own_domain(plan.get("home", ctx["url"]) if plan else ctx["url"])
        own_name = (ctx.get("business_name") or "").lower()
        self.think(f"Scanning {len(urls)} pages for competitor evidence (own domain: {own}).")

        pages: dict[str, str] = {}
        for u in urls[:6]:
            got = fetch(u)
            if got:
                pages[got[0]] = got[1]

        found: dict[str, dict] = {}
        for url, html in pages.items():
            for href, label in links(html):
                if not href.startswith("http"):
                    continue
                dom = _own_domain(href)
                if not dom or own in dom or dom in own:
                    continue
                if any(s in dom for s in SOCIAL + PLATFORM):
                    continue
                if CTA_LABEL.match(label or ""):
                    continue  # "Order Online" -> vendor CTA, not a rival
                if "." not in dom or len(dom) < 4:
                    continue
                name = _name_from_domain(dom)
                key = dom
                entry = found.setdefault(key, {"name": name, "url": f"https://{dom}",
                                               "sources": set()})
                entry["sources"].add(url)
            # "X vs Y" / "alternatives to X" mentions
            text = visible_text(html)
            for m in re.finditer(
                    r"\b([A-Z][A-Za-z&'’\- ]{2,30})\s+vs\.?\s+([A-Z][A-Za-z&'’\- ]{2,30})", text):
                for name in (m.group(1).strip(), m.group(2).strip()):
                    if len(name) > 3 and (not own_name or own_name not in name.lower()):
                        key = name.lower()
                        entry = found.setdefault(key, {"name": name, "url": None, "sources": set()})
                        entry["sources"].add(url)
                        entry["positioning"] = "mentioned in vs-comparison on site"

        findings = []
        for key, e in list(found.items())[:8]:
            comp: dict = {"name": e["name"][:80]}
            if e.get("url"):
                comp["url"] = e["url"]
            if e.get("positioning"):
                comp["positioning"] = e["positioning"]
            findings.append(self.finding(
                "competitors", comp, 0.55, sorted(e["sources"])))
        if findings:
            self.think(f"Found {len(findings)} competitor candidates from outbound links/mentions.")
        else:
            self.think("No competitor evidence on-site. Empty list — refusing to invent.")
            self.send("orchestrator", "no_competitor_evidence", {"pages": len(pages)})
        self.memory.write("status", f"found={len(findings)}")
        return findings
