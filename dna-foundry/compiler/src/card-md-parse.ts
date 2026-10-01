/**
 * card-md-parse — parse CARD.md (business-card/0.1) back into the machine
 * view (card JSON) + changelog. Mirror image of card-md's emitCardMd:
 * every line written there is read back here.
 *
 * verifyCardMd recomputes both the full card hash and the acting-layer hash
 * and compares them to the frontmatter. Tampering with either view fails.
 */
import { cardHash } from "./business-md";
import { actingHash } from "./card-md";

export interface ParsedCardMd {
  card: any;
  changelog: string[];
  frontmatter: Record<string, string>;
}

function parseFrontmatter(md: string): { fm: Record<string, string>; rest: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("CARD.md: missing YAML frontmatter envelope");
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, rest: m[2] };
}

/** Split body into ## sections. ### subsections stay inside their parent. */
function sections(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = h[1];
      out[cur] = [];
      continue;
    }
    if (cur && line !== "" && (!line.startsWith("<!--") || line.startsWith("<!-- machine:"))) out[cur].push(line);
  }
  return out;
}

/** Split an appendix section into ### subsections. */
function subsections(lines: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = "";
  for (const line of lines) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      cur = h[1];
      out[cur] = [];
      continue;
    }
    if (cur) out[cur].push(line);
  }
  return out;
}

function bullets(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
}

/**
 * Machine anchors: `<!-- machine:<tag> {...} -->` lines emitted by the
 * emitter. When present they are authoritative for that entry (exact
 * round-trip of arbitrary keys); hand-written cards without anchors fall
 * back to parsing the human bullets.
 */
function machineAnchors(lines: string[], tag: string): any[] {
  const out: any[] = [];
  const re = new RegExp(`^<!-- machine:${tag} (\\{.*\\}) -->$`);
  for (const l of lines) {
    const m = l.match(re);
    if (m) { try { out.push(JSON.parse(m[1])); } catch { /* ignore */ } }
  }
  return out;
}

function kv(b: string, key: string): string | null {
  const m = b.match(new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`));
  return m ? m[1] : null;
}

function listVal(s: string, sep: string): string[] {
  // Split on sep, honoring the emitter's backslash-escaped separator chars.
  const c = sep.trim();
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === c) { cur += c; i++; continue; }
    if (s.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out.map((x: string) => x.trim()).filter(Boolean);
}

/** Inverse of the emitter's esc(): \" -> ", \\ -> \ */
function unesc(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function quotedSegments(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(unesc(m[1]));
  return out;
}

/** Parse a flow-style mapping like {state: staged, brief: "...", asset: null, seconds: 4}. */
function parseFlowMap(s: string): Record<string, any> {
  const inner = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  const parts: string[] = [];
  let cur = "";
  let inStr = false;
  let escNext = false;
  for (const ch of inner) {
    if (escNext) { cur += ch; escNext = false; continue; }
    if (ch === "\\" && inStr) { cur += ch; escNext = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (ch === "," && !inStr) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out: Record<string, any> = {};
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    out[k] = parseScalar(v);
  }
  return out;
}

function parseScalar(v: string): any {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"')) return unesc(JSON.parse(v));
  return v;
}

/** Parse the Sound section's ```yaml fence back into voice.sonic. */
function parseSoundYaml(lines: string[]): any | null {
  const start = lines.findIndex((l) => l.trim() === "```yaml");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "```");
  if (start < 0 || end < 0) return null;
  const fence = lines.slice(start + 1, end);
  const entries: Record<string, any> = {};
  let ui: Record<string, any> | null = null;
  for (const raw of fence) {
    const line = raw.trimEnd();
    if (/^sound:\s*$/.test(line)) continue;
    const mUi = line.match(/^\s{2}ui:\s*$/);
    if (mUi) { ui = {}; continue; }
    const mTop = line.match(/^\s{2}(\w+):\s*(\{.*\})\s*$/);
    if (mTop && !ui) { entries[mTop[1]] = parseFlowMap(mTop[2]); continue; }
    const mSub = line.match(/^\s{4}(\w+):\s*(\{.*\})\s*$/);
    if (mSub && ui) { ui[mSub[1]] = parseFlowMap(mSub[2]); continue; }
  }
  if (ui) entries["ui"] = ui;
  const sonic: any = {};
  const build = (e: any, map: Record<string, string>) => {
    const o: any = {};
    for (const [yk, jk] of Object.entries(map)) {
      if (yk in e) o[jk] = e[yk]; // explicit nulls and "" survive; absent stays absent
    }
    return o;
  };
  if (entries.logo && Object.keys(entries.logo).length > 1)
    sonic.sonic_logo = build(entries.logo, { brief: "description", asset: "asset_ref", seconds: "duration_s" });
  if (entries.voice_logo && Object.keys(entries.voice_logo).length > 1)
    sonic.voice_logo = build(entries.voice_logo, { line: "script", voice: "voice_profile", asset: "asset_ref" });
  if (entries.ui) {
    const arr = [];
    for (const name of ["notification", "success", "error"]) {
      const e = entries.ui[name];
      if (e && Object.keys(e).length > 1) arr.push({ name, ...build(e, { brief: "description", asset: "asset_ref" }) });
    }
    if (arr.length) sonic.ui_sounds = arr;
  }
  return Object.keys(sonic).length ? sonic : null;
}

/** Parse an Offer bullet: **Name** · kind: x · note: y · orderable: yes · price: 12 · confidence: 0.6 */
function parseOffer(b: string): any {
  const m = b.match(/^\*\*(.+?)\*\*(.*)$/);
  if (!m) return null;
  const o: any = { name: m[1] };
  const rest = m[2].trim();
  if (rest.startsWith("·")) {
    for (const pair of rest.slice(1).split("·").map((s) => s.trim()).filter(Boolean)) {
      const i = pair.indexOf(":");
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (k === "kind") o.kind = v;
      else if (k === "note") o.description = v;
      else if (k === "orderable") o.orderable = v === "yes";
      else if (k === "price") o.price = v === "null" ? null : Number(v);
      else if (k === "price_hint") o.price_hint = v;
      else if (k === "confidence") o.confidence = Number(v);
    }
  }
  return o;
}

export function parseCardMd(md: string): ParsedCardMd {
  const { fm, rest } = parseFrontmatter(md);
  if (fm.format !== "business-card/0.1")
    throw new Error(`CARD.md: unsupported format '${fm.format}'`);
  const sec = sections(rest);
  const card: any = {};

  card.id = fm.id;
  card.version = Number(fm.version);
  // full-card hash lives in the frontmatter envelope; restore it so the JSON
  // machine view is complete (cardHash() excludes "hash" from its own input)
  card.hash = fm.hash ? fm.hash.replace(/^sha256:/, "") : null;
  // acting_hash is a stored card field (contract: required); the full-card
  // hash covers it, so restore it from the envelope like hash itself
  card.acting_hash = fm.acting_hash ? fm.acting_hash.replace(/^sha256:/, "") : null;
  // previous_version is null on v1 and a number afterwards; the emitter
  // omits null, so restore the null explicitly to keep the hash stable
  card.previous_version = fm.previous_version !== undefined ? Number(fm.previous_version) : null;
  // previous_hash is a real hashed card field (set by mutate.py / patch-sound);
  // restore it only when the frontmatter carries a real value so v1 cards
  // without the key round-trip exactly.
  if (fm.previous_hash && fm.previous_hash !== "none")
    card.previous_hash = fm.previous_hash.replace(/^sha256:/, "");
  card.organization_id = fm.organization_id;
  card.status = fm.status || "draft";
  card.created_at = fm.updated;

  // 1. Identity
  {
    const id: any = {};
    const set = (b: string, key: string, jk: string, fn?: (s: string) => any) => {
      const v = kv(b, key);
      if (v !== null) id[jk] = fn ? fn(v) : v;
    };
    for (const b of bullets(sec["Identity"] || [])) {
      set(b, "Name", "name");
      set(b, "Pitch", "elevator_pitch");
      set(b, "Tagline", "tagline");
      set(b, "Mission", "mission");
      set(b, "Values", "values", (s) => listVal(s, ";"));
      set(b, "Founded", "founded");
      set(b, "Address", "location");
      set(b, "Phone", "phone");
      set(b, "Email", "email");
      set(b, "Timezone", "timezone");
      set(b, "Source", "website");
    }
    // tagline blockquote under the H1
    const qm = rest.match(/^# .+\n\n> (.+)\n/m);
    if (qm && !id.tagline) id.tagline = qm[1];
    if (Object.keys(id).length) card.identity = id;
  }

  // 2. Voice
  {
    const v: any = {};
    for (const b of bullets(sec["Voice"] || [])) {
      const t = kv(b, "Tone"); if (t !== null) v.tone = listVal(t, ",");
      const p = kv(b, "Personality"); if (p !== null) v.personality = p;
      const d = kv(b, "Description"); if (d !== null) v.description = d;
      const s = kv(b, "Samples"); if (s !== null) v.sample_phrases = quotedSegments(s);
      const dt = kv(b, "Don't"); if (dt !== null) v.donts = listVal(dt, ";");
      const u = kv(b, "Use"); if (u !== null) v.lexicon_use = listVal(u, ",");
      const n = kv(b, "Never"); if (n !== null) v.lexicon_never = listVal(n, ",");
    }
    const sonic = parseSoundYaml(sec["Sound"] || []);
    if (sonic) v.sonic = sonic;
    if (Object.keys(v).length) card.voice = v;
  }

  // 4. Offer
  {
    const anchored = machineAnchors(sec["Offer"] || [], "offering");
    const offs = anchored.length
      ? anchored
      : bullets(sec["Offer"] || []).map(parseOffer).filter(Boolean);
    if (offs.length) card.offerings = offs;
  }

  // 5. Operations
  {
    const o: any = {};
    for (const b of bullets(sec["Operations"] || [])) {
      const h = kv(b, "Hours"); if (h !== null) o.hours = h;
      const c = kv(b, "Channels"); if (c !== null) o.channels = listVal(c, ",");
      const dv = kv(b, "Delivery"); if (dv !== null) o.delivery_fence = dv;
      const ct = kv(b, "Catering"); if (ct !== null) o.catering = ct;
      const hc = kv(b, "Human confirm"); if (hc !== null) o.human_confirm = listVal(hc, ";");
      const sy = kv(b, "Systems"); if (sy !== null) o.systems = listVal(sy, ",");
      const nt = kv(b, "Notes"); if (nt !== null) o.notes = nt;
    }
    if (Object.keys(o).length) card.operations = o;
  }

  // 6. Policy
  {
    const anchored = machineAnchors(sec["Policy"] || [], "policy");
    if (anchored.length) {
      card.policies = anchored;
    } else {
      const pls = [];
      for (const b of bullets(sec["Policy"] || [])) {
        const m = b.match(/^\*\*(.+?):\*\*\s*(.+)$/);
        if (m) pls.push({ topic: m[1], rule: m[2] });
      }
      if (pls.length) card.policies = pls;
    }
  }

  // 7. Handoff
  {
    const h: any = {};
    for (const b of bullets(sec["Handoff"] || [])) {
      const oh = kv(b, "Open hours"); if (oh !== null) h.open_hours = oh;
      const ch = kv(b, "Channel"); if (ch !== null) h.channel = ch;
      const ah = kv(b, "After hours"); if (ah !== null) h.after_hours = ah;
      const th = kv(b, "To human"); if (th !== null) h.to_human = listVal(th, ";");
      const ct = kv(b, "Contact"); if (ct !== null) h.contact = ct;
    }
    if (Object.keys(h).length) card.handoff = h;
  }

  // 8. Knowledge
  {
    const anchored = machineAnchors(sec["Knowledge"] || [], "knowledge");
    if (anchored.length) {
      card.knowledge = anchored;
    } else {
      const kn = [];
      for (const b of bullets(sec["Knowledge"] || [])) {
        const m = b.match(/^\[(.+?)\]\((.+?)\)\s*·\s*(.+?)\s*·\s*(\d+)\s+chunks$/);
        if (m) kn.push({ title: m[1], ref: m[2], kind: m[3], chunks: parseInt(m[4], 10) });
      }
      if (kn.length) card.knowledge = kn;
    }
  }

  // 9. Provenance
  {
    const prov: any = {};
    for (const b of bullets(sec["Provenance"] || [])) {
      const m = b.match(/^`([^`]+)`\s*—\s*sources:\s*\[(.*?)\],\s*confidence\s*([\d.]+),\s*extractor:\s*(\S+),\s*(\S+)\s*$/);
      if (m) prov[m[1]] = {
        sources: m[2] ? m[2].split(", ").filter(Boolean) : [],
        confidence: parseFloat(m[3]),
        extractor_agent: m[4],
        extracted_at: m[5],
      };
    }
    if (Object.keys(prov).length) card.field_provenance = prov;
  }

  // 10. Changelog
  const changelog = bullets(sec["Changelog"] || []);

  // 11. Appendix (not quotable)
  if (sec["Appendix"]) {
    const sub = subsections(sec["Appendix"]);
    if (sub["Strategy"]) {
      const st: any = { swot: {} };
      const lines = sub["Strategy"];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith("- ")) continue;
        const b = line.slice(2);
        const pm = b.match(/^\*\*(.+?):\*\*\s*(.*)$/);
        if (!pm) continue;
        const key = pm[1].trim();
        if (key === "Positioning") { st.positioning = pm[2]; continue; }
        if (key === "Key messaging") { st.key_messaging = listVal(pm[2], ";"); continue; }
        if (key === "SWOT") {
          // consume the following indented sub-bullets
          let j = i + 1;
          while (j < lines.length && /^\s+-\s/.test(lines[j])) {
            const sb = lines[j].replace(/^\s+-\s+/, "");
            const sm = sb.match(/^\*\*(Strengths|Weaknesses|Opportunities|Threats):\*\*\s*(.+)$/);
            if (sm) st.swot[sm[1].toLowerCase()] = listVal(sm[2], ";");
            j++;
          }
          i = j - 1;
        }
      }
      if (st.positioning || st.key_messaging || Object.keys(st.swot).length) card.strategy = st;
    }
    if (sub["Customers"]) {
      const cu: any = {};
      const personas = [];
      for (const b of bullets(sub["Customers"])) {
        const t = kv(b, "Touchpoints");
        if (t !== null) { cu.touchpoints = listVal(t, ","); continue; }
        const pm = b.match(/^\*\*Persona:\s*(.+?)\*\*\s*(?:—\s*(.+))?$/);
        if (pm) {
          const p: any = { name: pm[1] };
          if (pm[2]) {
            const bits = pm[2].split(" · ").map((s: string) => s.trim());
            const descBits: string[] = [];
            for (const bit of bits) {
              if (/^role:\s*/i.test(bit)) p.role = bit.replace(/^role:\s*/i, "");
              else if (/^pain points:\s*/i.test(bit)) p.pain_points = listVal(bit.replace(/^pain points:\s*/i, ""), ";");
              else if (/^confidence:\s*/i.test(bit)) p.confidence = Number(bit.replace(/^confidence:\s*/i, ""));
              else if (/^source:\s*/i.test(bit)) p.source = bit.replace(/^source:\s*/i, "");
              else if (/inferred/.test(bit)) p.inferred = true;
              else descBits.push(bit);
            }
            if (descBits.length) p.description = descBits.join(" · ");
          }
          personas.push(p);
        }
      }
      if (personas.length) cu.personas = personas;
      if (Object.keys(cu).length) card.customers = cu;
    }
    if (sub["Competitors"]) {
      const anchored = machineAnchors(sub["Competitors"] || [], "competitor");
      if (anchored.length) {
        card.competitors = anchored;
      } else {
      const comps = [];
      for (const b of bullets(sub["Competitors"])) {
        const m = b.match(/^\*\*(.+?)\*\*(?:\s*—\s*(.+?))?(?:\s*\(inferred — confirm with owner\))?$/);
        if (m) {
          const c: any = { name: m[1] };
          if (m[2]) c.positioning = m[2];
          if (/\(inferred — confirm with owner\)/.test(b)) c.inferred = true;
          comps.push(c);
        }
      }
      if (comps.length) card.competitors = comps;
      }
    }
    if (sub["Insights"]) {
      const anchored = machineAnchors(sub["Insights"] || [], "insight");
      if (anchored.length) {
        card.insights = anchored;
      } else {
      const ins = [];
      for (const b of bullets(sub["Insights"])) {
        const m = b.match(/^\*\*(.+?)\*\*\s*—\s*(.+?)(?:\s*\(evidence:\s*(.+)\))?$/);
        if (m) {
          const i: any = { title: m[1], detail: m[2] };
          if (m[3]) i.evidence = listVal(m[3], "; ");
          ins.push(i);
        }
      }
      if (ins.length) card.insights = ins;
      }
    }
    if (sub["Visual"]) {
      const vi: any = {};
      for (const b of bullets(sub["Visual"])) {
        const pc = kv(b, "Primary color"); if (pc !== null) vi.primary_color = pc;
        const sc = kv(b, "Secondary color"); if (sc !== null) vi.secondary_color = sc;
        const fp = kv(b, "Font pairing"); if (fp !== null) vi.font_pairing = fp;
        const sk = kv(b, "Style keywords"); if (sk !== null) vi.style_keywords = listVal(sk, ",");
        const ds = kv(b, "Design system"); if (ds !== null) vi.design_system = ds;
        const is = kv(b, "Image style"); if (is !== null) vi.image_style = is;
      }
      if (Object.keys(vi).length) card.visual = vi;
    }
  }

  return { card, changelog, frontmatter: fm };
}

export function verifyCardMd(md: string): { ok: boolean; reason: string; card?: any } {
  let parsed: ParsedCardMd;
  try {
    parsed = parseCardMd(md);
  } catch (e: any) {
    return { ok: false, reason: "parse error: " + e.message };
  }
  const { card, frontmatter: fm } = parsed;
  // acting_hash first: it is covered by the full hash, so a tampered
  // acting_hash would otherwise surface as a generic hash mismatch
  const wantActing = "sha256:" + actingHash(card);
  if (fm.acting_hash !== wantActing)
    return { ok: false, reason: `acting_hash mismatch: frontmatter ${fm.acting_hash} != recomputed ${wantActing}` };
  const wantHash = "sha256:" + cardHash(card);
  if (fm.hash !== wantHash)
    return { ok: false, reason: `hash mismatch: frontmatter ${fm.hash} != recomputed ${wantHash}` };
  return { ok: true, reason: "hash + acting_hash verified", card };
}
