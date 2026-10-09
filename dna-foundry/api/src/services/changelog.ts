/**
 * changelog — hash-chained card mutation history.
 *
 * Every card write (extract or compile) appends an entry.
 * Each entry hashes itself against the previous entry so the
 * chain can be verified for tampering at any time.
 *
 * Storage: /etc/helix/companies/{companyId}/changelog.json
 */

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MutationType =
  | "owner-confirmed"
  | "inferred"
  | "promoted"
  | "created"
  | "restored";

export interface ChangelogEntry {
  version: number;
  timestamp: string;
  fieldsChanged: string[];       // dot-notation paths, e.g. ["identity.name", "voice.tone"]
  mutationType: MutationType;
  previousHash: string;          // sha256 of the previous entry's entryHash (or "genesis")
  entryHash: string;             // sha256(previousHash|version|timestamp|sorted fields)
  author: string;                // "owner" | "extractor" | "compiler" | "system"
  note?: string;
}

export interface CardChangelog {
  cardId: string;
  companyId: string;
  entries: ChangelogEntry[];
  headHash: string;              // entryHash of the most recent entry
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Produce a deterministic sha256 hex digest for a single entry. */
function hashEntry(
  previousHash: string,
  version: number,
  ts: string,
  fields: string[],
): string {
  const content = `${previousHash}|${version}|${ts}|${[...fields].sort().join(",")}`;
  return crypto.createHash("sha256").update(content).digest("hex");
}

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Load / create
// ---------------------------------------------------------------------------

/**
 * Load the changelog for a card.  If the file does not exist (or the card
 * has no entries yet) a fresh empty changelog is returned without writing.
 */
export async function loadChangelog(
  changelogPath: string,
  cardId: string,
  companyId: string,
): Promise<CardChangelog> {
  try {
    const raw = await fs.readFile(changelogPath, "utf8");
    const parsed = JSON.parse(raw) as CardChangelog;
    // Ensure structure is coherent
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    if (!parsed.headHash) {
      parsed.headHash = parsed.entries.length
        ? parsed.entries[parsed.entries.length - 1].entryHash
        : GENESIS_HASH;
    }
    return parsed;
  } catch {
    // File doesn't exist yet
    return {
      cardId,
      companyId,
      entries: [],
      headHash: GENESIS_HASH,
    };
  }
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a new changelog entry, persist it, and return the new entry.
 *
 * @param changelogPath  Absolute path to the changelog.json file.
 */
export async function appendChange(
  changelogPath: string,
  cardId: string,
  companyId: string,
  fieldsChanged: string[],
  mutationType: MutationType,
  author: string,
  note?: string,
): Promise<ChangelogEntry> {
  const log = await loadChangelog(changelogPath, cardId, companyId);

  const version = log.entries.length + 1;
  const timestamp = new Date().toISOString();
  const previousHash = log.headHash;

  const entryHash = hashEntry(previousHash, version, timestamp, fieldsChanged);

  const entry: ChangelogEntry = {
    version,
    timestamp,
    fieldsChanged: [...fieldsChanged].sort(),
    mutationType,
    previousHash,
    entryHash,
    author,
    ...(note !== undefined ? { note } : {}),
  };

  log.entries.push(entry);
  log.headHash = entryHash;

  // Ensure directory exists before writing
  await fs.mkdir(path.dirname(changelogPath), { recursive: true });
  await fs.writeFile(changelogPath, JSON.stringify(log, null, 2), "utf8");

  return entry;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Walk the entire chain and confirm every hash links correctly.
 * Returns `{valid: true}` or `{valid: false, brokenAt, error}`.
 */
export async function verifyChain(
  changelogPath: string,
): Promise<{ valid: boolean; brokenAt?: number; error?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(changelogPath, "utf8");
  } catch {
    return { valid: false, error: "changelog file not found" };
  }

  let log: CardChangelog;
  try {
    log = JSON.parse(raw) as CardChangelog;
  } catch {
    return { valid: false, error: "changelog is not valid JSON" };
  }

  if (!Array.isArray(log.entries) || log.entries.length === 0) {
    return { valid: true };
  }

  let expectedPrevious = GENESIS_HASH;

  for (const entry of log.entries) {
    // Recompute expected hash
    const computed = hashEntry(
      expectedPrevious,
      entry.version,
      entry.timestamp,
      entry.fieldsChanged,
    );

    if (entry.previousHash !== expectedPrevious) {
      return {
        valid: false,
        brokenAt: entry.version,
        error: `entry v${entry.version}: previousHash mismatch`,
      };
    }

    if (entry.entryHash !== computed) {
      return {
        valid: false,
        brokenAt: entry.version,
        error: `entry v${entry.version}: entryHash tampered`,
      };
    }

    expectedPrevious = entry.entryHash;
  }

  // Confirm headHash matches last entry
  const lastHash = log.entries[log.entries.length - 1].entryHash;
  if (log.headHash !== lastHash) {
    return { valid: false, error: "headHash does not match last entry" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Recursively walk two plain objects and return every dot-notation path
 * where the value differs (including new/removed keys).
 */
export function diffCards(oldCard: Record<string, unknown>, newCard: Record<string, unknown>): string[] {
  const changed: string[] = [];

  function walk(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    prefix: string,
  ): void {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const av = a[key];
      const bv = b[key];

      if (av === bv) continue;

      if (
        av !== null &&
        bv !== null &&
        typeof av === "object" &&
        typeof bv === "object" &&
        !Array.isArray(av) &&
        !Array.isArray(bv)
      ) {
        walk(
          av as Record<string, unknown>,
          bv as Record<string, unknown>,
          fullPath,
        );
      } else {
        // Arrays or scalars — compare by JSON string
        if (JSON.stringify(av) !== JSON.stringify(bv)) {
          changed.push(fullPath);
        }
      }
    }
  }

  walk(oldCard, newCard, "");
  return changed.sort();
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Render a `CardChangelog` as a human-readable markdown document.
 */
export function changelogToMarkdown(log: CardChangelog): string {
  const header = `# Card Changelog — ${log.companyId}\n\n`;

  if (log.entries.length === 0) {
    return `${header}_No changes recorded yet._\n`;
  }

  const sections = [...log.entries]
    .reverse() // newest first
    .map((e) => {
      const date = e.timestamp.slice(0, 10);
      const fieldsLine = e.fieldsChanged.length
        ? e.fieldsChanged.join(", ")
        : "_no fields recorded_";
      const noteLine = e.note ? `\n${e.note}\n` : "";
      const hashSnip = e.entryHash.slice(0, 16);

      return [
        `## v${e.version} · ${date} · ${e.mutationType}`,
        `**Changed:** ${fieldsLine}`,
        `**Author:** ${e.author}`,
        noteLine.trim(),
        `**Hash:** \`${hashSnip}\``,
        `---`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    });

  return header + sections.join("\n\n") + "\n";
}
