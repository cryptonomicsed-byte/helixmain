/**
 * signup.ts — self-serve provisioning.
 *
 * ONE job: turn a verified signup (a passkey registration, or a Google identity)
 * into a real company on disk. This is the front door the platform did not have:
 * before this, a stranger became a company only when an operator ran
 * helix-onboard.sh and then hand-issued an enrollment token.
 *
 * What it writes, and what it deliberately does NOT:
 *
 *   writes    <slug>/api-keys.json   identity + credentials (via ensureKeys)
 *             <slug>/seckey          the channel identity onboarding writes
 *             <slug>/passkeys.json   the credential, for passkey signup
 *             <slug>/account.json    the signup record (who, how, when)
 *             the credit account     Free tier, granted once
 *
 *   does NOT  write a card. The card comes from the URL the owner pastes next,
 *             and a hand-authored card JSON without a real compiler hash is the
 *             landmine this codebase already documents. A company with keys and
 *             no card is exactly the `provisioned` state companies.ts defines.
 *
 * The pending record exists because a WebAuthn ceremony spans two requests. It is
 * keyed by the reserved slug and expires, so an abandoned signup releases its name.
 */
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { HELIX_COMPANIES, isProvisionedCompany } from "./companies";
import { ensureKeys, resetKeyCache } from "./apiKeys";
import { addCredential, type StoredCredential } from "./passkeys";
import { initAccount } from "./metering";

const PENDING_DIR = process.env.HELIX_PENDING_DIR || "/etc/helix/signups/pending";
const PENDING_TTL_MS = 15 * 60 * 1000;

export type SignupProvider = "passkey" | "google";

export interface AccountRecord {
  slug: string;
  business: string;
  email: string | null;
  website: string | null;
  provider: SignupProvider;
  googleSub?: string | null;
  createdAt: string;
  status: "provisioned";
}

interface PendingSignup {
  slug: string;
  business: string;
  email: string | null;
  website: string | null;
  exp: number;
}

// ── pending signups (the options -> verify window) ─────────────────────────

export async function savePending(p: {
  slug: string;
  business: string;
  email?: string | null;
  website?: string | null;
}): Promise<void> {
  await fs.promises.mkdir(PENDING_DIR, { recursive: true });
  const rec: PendingSignup = {
    slug: p.slug,
    business: p.business,
    email: p.email ?? null,
    website: p.website ?? null,
    exp: Date.now() + PENDING_TTL_MS,
  };
  await fs.promises.writeFile(path.join(PENDING_DIR, `${p.slug}.json`), JSON.stringify(rec, null, 2), {
    mode: 0o600,
  });
}

export async function loadPending(slug: string): Promise<PendingSignup | null> {
  try {
    const raw = JSON.parse(
      await fs.promises.readFile(path.join(PENDING_DIR, `${slug}.json`), "utf8"),
    ) as PendingSignup;
    if (!raw || typeof raw.exp !== "number" || raw.exp < Date.now()) {
      await clearPending(slug);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function clearPending(slug: string): Promise<void> {
  await fs.promises.rm(path.join(PENDING_DIR, `${slug}.json`), { force: true }).catch(() => {});
}

/** Slugs held by unverified signups — so two people signing up at once can't be
 *  handed the same one before either has finished. */
export function pendingSlugs(): string[] {
  try {
    return fs
      .readdirSync(PENDING_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// ── account records ────────────────────────────────────────────────────────

export function accountPath(slug: string): string {
  return path.join(HELIX_COMPANIES, slug, "account.json");
}

export function readAccount(slug: string): AccountRecord | null {
  try {
    return JSON.parse(fs.readFileSync(accountPath(slug), "utf8")) as AccountRecord;
  } catch {
    return null;
  }
}

/** A returning Google user maps back to the company they already own. */
export function findByGoogleSub(sub: string): string | null {
  if (!sub) return null;
  try {
    for (const id of fs.readdirSync(HELIX_COMPANIES)) {
      const acct = readAccount(id);
      if (acct && acct.googleSub && acct.googleSub === sub) return id;
    }
  } catch {
    /* no companies yet */
  }
  return null;
}

// ── provisioning ───────────────────────────────────────────────────────────

/**
 * Create the company. Idempotent-ish: it will not clobber an existing company's
 * keys or seckey, so a retried verify cannot rotate credentials out from under a
 * live account (same discipline as ensureKeys).
 */
export async function provisionCompany(opts: {
  slug: string;
  business: string;
  email?: string | null;
  website?: string | null;
  provider: SignupProvider;
  googleSub?: string | null;
  credential?: StoredCredential | null;
}): Promise<AccountRecord> {
  const { slug } = opts;
  const dir = path.join(HELIX_COMPANIES, slug);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

  // The identity key onboarding writes; used as the company's channel identity by
  // agent-voice / ZeroClaw. Generated, never printed.
  const seckeyPath = path.join(dir, "seckey");
  if (!fs.existsSync(seckeyPath)) {
    await fs.promises.writeFile(seckeyPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }

  ensureKeys(slug); // <slug>/api-keys.json, 0600, idempotent
  resetKeyCache(); // the key set changed this instant; don't wait out the 10s TTL

  if (opts.credential) addCredential(slug, opts.credential);

  const account: AccountRecord = {
    slug,
    business: opts.business,
    email: opts.email ?? null,
    website: opts.website ?? null,
    provider: opts.provider,
    googleSub: opts.googleSub ?? null,
    createdAt: new Date().toISOString(),
    status: "provisioned",
  };
  await fs.promises.writeFile(accountPath(slug), JSON.stringify(account, null, 2), { mode: 0o600 });

  // Free tier. initAccount refuses unless the company exists on disk — which it
  // now does (ensureKeys just wrote the key file). A failure here must not lose the
  // signup: the account store is in-memory and reloads from disk.
  if (isProvisionedCompany(slug)) {
    try {
      initAccount(slug);
    } catch {
      /* account store will re-init on demand */
    }
  }

  return account;
}
