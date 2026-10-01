/**
 * CARD.md — canonical JSON helpers + emitter.
 *
 * canonicalJson / cardHash replicate Python's
 *   json.dumps(obj, sort_keys=True, separators=(",", ":"))
 * so the frontmatter `hash` in CARD.md equals the swarm's card["hash"].
 * Tampering with either view is detectable.
 */
import { createHash } from "crypto";

export function canonicalJson(v: any): string {
  return canonValue(prune(v));
}

function canonValue(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonValue).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => canonStr(k) + ":" + canonValue(v[k])).join(",") + "}";
  }
  if (typeof v === "string") return canonStr(v);
  if (typeof v === "number") {
    if (!isFinite(v)) throw new Error("non-finite number in card");
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/** Bottom-up prune, mirroring Python's canonical._prune: empty arrays and
 *  empty objects as object values are identical to a missing key for
 *  identity purposes ("threats": [] === no threats key). */
function prune(v: any): any {
  if (Array.isArray(v)) return v.map(prune);
  if (v !== null && typeof v === "object") {
    const out: any = {};
    for (const k of Object.keys(v)) {
      const pv = prune(v[k]);
      if (Array.isArray(pv) && pv.length === 0) continue;
      if (pv !== null && typeof pv === "object" && Object.keys(pv).length === 0) continue;
      out[k] = pv;
    }
    return out;
  }
  return v;
}

/** JSON string with Python ensure_ascii semantics. Built without escapes:
 *  take JSON's own inner encoding, then rewrite every non-ASCII char. */
function canonStr(s: string): string {
  const inner = JSON.stringify(s).slice(1, -1);
  let out = "";
  for (const ch of inner) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 128) {
      out += ch;
    } else if (cp < 65536) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    } else {
      const w = cp - 65536;
      const hi = 55296 + (w >> 10);
      const lo = 56320 + (w & 1023);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    }
  }
  return '"' + out + '"';
}

/** SHA-256 hex of the canonical JSON, excluding the card's own `hash`
 *  and any `_`-prefixed ephemeral fields. Equals the swarm's card["hash"]. */
export function cardHash(card: any): string {
  const body: any = {};
  for (const k of Object.keys(card)) {
    if (k !== "hash" && k.charAt(0) !== "_") body[k] = card[k];
  }
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

