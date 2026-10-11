/**
 * siteGenerator — generates a full, professional, multi-section HTML landing page
 * from a BrandDNA card. HTML stored in memory and persisted to disk.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteGenerateResult {
  companyId: string;
  html: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const siteStore = new Map<string, SiteGenerateResult>();

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const SITES_PATH = process.env.HELIX_SITES_PATH ?? "/etc/helix/data/sites.json";

export async function loadSiteStore(): Promise<void> {
  try {
    const raw = await fs.readFile(SITES_PATH, "utf8");
    const entries = JSON.parse(raw) as Array<[string, SiteGenerateResult]>;
    for (const [id, site] of entries) siteStore.set(id, site);
  } catch {
    // file may not exist on first run — silently skip
  }
}

async function saveSiteStore(): Promise<void> {
  try {
    const dir = path.dirname(SITES_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(SITES_PATH, JSON.stringify(Array.from(siteStore.entries()), null, 2));
  } catch {
    // never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cardName(card: any): string {
  return card?.identity?.name ?? card?.name?.value ?? "Our Business";
}

function cardTagline(card: any): string {
  return card?.identity?.tagline ?? card?.tagline ?? "";
}

function cardElevatorPitch(card: any): string {
  return card?.identity?.elevatorPitch ?? card?.elevator_pitch ?? card?.description ?? "";
}

function cardPhone(card: any): string {
  return card?.phone?.value ?? card?.phone ?? "";
}

function cardAddress(card: any): string {
  return card?.address?.value ?? card?.address ?? "";
}

function cardHours(card: any): string {
  if (card?.hours) {
    if (typeof card.hours === "object" && !Array.isArray(card.hours)) {
      return Object.entries(card.hours).map(([d, h]) => `${d}: ${h}`).join(", ");
    }
    return String(card.hours);
  }
  return "";
}

function cardTone(card: any): string {
  const tone = card?.voice?.tone;
  if (Array.isArray(tone)) return tone.join(", ");
  return String(tone ?? "professional and welcoming");
}

function cardOfferings(card: any): Array<{ name: string; description: string; price?: string }> {
  const raw: any[] = card?.offerings ?? [];
  return raw.map((o: any) => ({
    name:        String(o.name ?? o ?? ""),
    description: String(o.description ?? o.detail ?? ""),
    price:       o.price ? String(o.price) : undefined,
  }));
}

function cardSpecials(card: any): Array<{ title: string; description: string }> {
  const raw: any[] = card?.specials ?? card?.special_offers ?? [];
  return raw.map((s: any) => ({
    title:       String(s.title ?? s.name ?? s ?? ""),
    description: String(s.description ?? s.detail ?? ""),
  }));
}

function cardValues(card: any): string[] {
  const v = card?.identity?.values ?? card?.values ?? [];
  return Array.isArray(v) ? v.map(String) : [];
}

/** Map tone words to a brand color palette */
function toneToColors(tone: string): {
  primary: string; accent: string; bg: string; surface: string; text: string; textMuted: string;
} {
  const t = tone.toLowerCase();
  if (/luxury|premium|gold|elegant|upscale/.test(t)) {
    return { primary: "#c9a84c", accent: "#e8c97a", bg: "#0a0a0a", surface: "#141414", text: "#f0ead6", textMuted: "#a09060" };
  }
  if (/warm|energetic|bold|vibrant|fun|exciting/.test(t)) {
    return { primary: "#e85d04", accent: "#f48c06", bg: "#0d0a07", surface: "#1a1208", text: "#fdf0e0", textMuted: "#b07040" };
  }
  if (/friendly|casual|community|local|approachable/.test(t)) {
    return { primary: "#2d9e4f", accent: "#4caf72", bg: "#080e0a", surface: "#0e1a10", text: "#e8f5eb", textMuted: "#5a8a68" };
  }
  if (/tech|innovation|modern|digital|cutting/.test(t)) {
    return { primary: "#6c63ff", accent: "#9d98ff", bg: "#08070f", surface: "#110f1e", text: "#e8e6ff", textMuted: "#6a65a0" };
  }
  // default: professional / formal / blue
  return { primary: "#1a6ed8", accent: "#4a9eff", bg: "#080b14", surface: "#0e1520", text: "#e4eaf4", textMuted: "#4a6080" };
}

// ---------------------------------------------------------------------------
// generateWebsite
// ---------------------------------------------------------------------------

export async function generateWebsite(
  card: any,
  companyId: string,
): Promise<SiteGenerateResult> {
  const name      = cardName(card);
  const tagline   = cardTagline(card);
  const pitch     = cardElevatorPitch(card);
  const phone     = cardPhone(card);
  const address   = cardAddress(card);
  const hours     = cardHours(card);
  const tone      = cardTone(card);
  const offerings = cardOfferings(card);
  const specials  = cardSpecials(card);
  const values    = cardValues(card);
  const colors    = toneToColors(tone);

  const offeringsList = offerings.length
    ? offerings.map((o) => `- ${o.name}${o.description ? `: ${o.description}` : ""}${o.price ? ` (Price: ${o.price})` : ""}`).join("\n")
    : "- Our core services";

  const specialsList = specials.length
    ? specials.map((s) => `- ${s.title}: ${s.description}`).join("\n")
    : "";

  const valuesList = values.length ? values.join(", ") : "Quality, trust, customer care";

  const addressEncoded = encodeURIComponent(address || name);
  const currentYear = new Date().getFullYear();

  const prompt = `You are a world-class web designer building a production landing page. Generate a complete, stunning, single-file HTML page for this business. The output must be ONLY valid HTML — no markdown, no code fences, no explanation.

BUSINESS DETAILS:
- Name: ${name}
- Tagline: ${tagline || "Excellence in every interaction"}
- About / Elevator Pitch: ${pitch || "We are dedicated to serving our community with quality and care."}
- Core Values: ${valuesList}
- Phone: ${phone || "Contact us for details"}
- Address: ${address || ""}
- Hours: ${hours || "Call for hours"}
- Voice / Tone: ${tone}
- AI Agent Call URL: https://helixmain.duckdns.org/api/call/${companyId}

OFFERINGS:
${offeringsList}

${specialsList ? `SPECIAL OFFERS:\n${specialsList}` : ""}

COLOR PALETTE (use these EXACTLY):
- Background: ${colors.bg}
- Surface / Card bg: ${colors.surface}
- Primary brand color: ${colors.primary}
- Accent: ${colors.accent}
- Text: ${colors.text}
- Muted text: ${colors.textMuted}

REQUIRED SECTIONS (include ALL of them in order):

1. STICKY NAV BAR
   - Business name/logo on the left, nav links: About, Services, Offers, Gallery, Hours, Contact
   - Smooth-scroll links using href="#sectionId"
   - "Contact Us" button (right side, primary color)
   - Hamburger menu toggle on mobile (pure JS, no library)
   - Active section highlighting via IntersectionObserver

2. HERO SECTION (full-viewport height, id="hero")
   - Bold 72px+ headline with the business name
   - Tagline as a subtitle
   - Elevator pitch as a short paragraph
   - Two CTA buttons: "Book Now / Contact Us" (primary) and "Talk to our AI Agent" (ghost/outline, links to https://helixmain.duckdns.org/api/call/${companyId})
   - Subtle animated background: CSS gradient animation (no canvas needed)

3. ABOUT SECTION (id="about")
   - Business story, values, mission
   - Two-column grid: text left, stylized values list right
   - Fade-in on scroll (IntersectionObserver + CSS transition)

4. SERVICES SECTION (id="services")
   - Tabbed layout: each offering is a tab (up to 6). First tab active by default. Pure JS tab switching.
   - Each tab panel: offering name (h3), description, price badge (if any), CTA button
   - If fewer than 3 offerings, show as a card grid instead of tabs
   - Card hover effect with transform scale and glow shadow

5. SPECIAL OFFERS SECTION (id="offers") — ONLY include if specials were provided above, otherwise SKIP entirely
   - Highlighted banner strip in accent color
   - Each offer as a card with title, description
   - Countdown timer JS: each card shows time counting down from 7 days after page load
   - Countdown format: Xd Xh Xm Xs

6. GALLERY / SOCIAL PROOF SECTION (id="gallery")
   - Grid of 6 placeholder boxes using CSS linear-gradient in brand colors (no external images)
   - 3 AI-generated testimonials appropriate to this type of business
   - Each testimonial: customer name, star rating (★★★★★), quote text

7. HOURS & LOCATION SECTION (id="hours")
   - Clean table with business hours. Use provided hours data or generate plausible ones for this business type.
   - Highlight current day row via JS: compare day name to current weekday
   - Address with Google Maps link: https://maps.google.com/?q=${addressEncoded}
   - Phone as tel: link

8. CONTACT FORM SECTION (id="contact")
   - Fields: Name, Email, Phone, Message
   - Submit: fetch POST /api/contact/${companyId} with JSON {name, email, phone, message}
   - Show inline success or error message, no page reload

9. AI AGENT CTA SECTION (id="ai-agent")
   - Full-width section with dark gradient
   - Heading: "Chat with Our AI Agent — Available 24/7"
   - Subtext about instant answers
   - Glowing pulsing CTA button linking to https://helixmain.duckdns.org/api/call/${companyId}

10. FOOTER
    - Business name, copyright ${currentYear} ${name}
    - "Powered by Helix AI" in small muted text
    - Social placeholder icons

TECHNICAL REQUIREMENTS:
- Full inline CSS in a single <style> block in <head>
- No external stylesheets, no CDN, no external JS
- Responsive: CSS Grid + Flexbox, media queries at 768px
- html { scroll-behavior: smooth }
- All JS in a single <script> block before </body>
- IntersectionObserver for fade-in-on-scroll: elements with class "fade-in" get class "visible"
- Tab switching, hamburger menu, countdown timers, form submit, day highlight — all vanilla JS
- Font: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif
- Include <meta charset="UTF-8">, <meta name="viewport">, <meta name="description">, <title>

Return ONLY the complete HTML document starting with <!DOCTYPE html>. No markdown. No code fences. No explanation.`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt:
      "You are a professional web designer. Return ONLY a complete, valid HTML document. No markdown. No code fences. No explanation. Start with <!DOCTYPE html>.",
    jsonMode: false,
    temperature: 0.7,
    maxTokens: 8000,
    orgId: companyId,
    operationType: "site_generate",
  });

  // Strip any accidental markdown fences
  let html = res.text.trim();
  if (html.startsWith("```")) {
    html = html.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  // Ensure it starts with a doctype
  if (!html.toLowerCase().startsWith("<!doctype")) {
    html = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title></head><body>${html}</body></html>`;
  }

  const result: SiteGenerateResult = {
    companyId,
    html,
    generatedAt: new Date().toISOString(),
  };

  siteStore.set(companyId, result);
  saveSiteStore().catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// getWebsite / listSites
// ---------------------------------------------------------------------------

export function getWebsite(companyId: string): SiteGenerateResult | null {
  return siteStore.get(companyId) ?? null;
}

export function listSites(): string[] {
  return Array.from(siteStore.keys());
}
