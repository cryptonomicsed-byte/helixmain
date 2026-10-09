/**
 * affiliate — referral tracking and commission award system.
 *
 * Commission rates by referrer tier:
 *   free   → 10% of payment USD converted to credits
 *   pro    → 15%
 *   agency → 20%
 *
 * Credits awarded = floor(paymentUsd * rate / 0.01)  (since 1 credit = $0.01)
 */

import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { topUpCredits, getCreditSummary } from "./metering";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AffiliateAccount {
  companyId: string;
  referralCode: string;
  referredBy?: string;       // companyId of referrer
  referrals: string[];       // companyIds this account referred
  totalEarned: number;       // credits earned through affiliate program
  createdAt: string;
}

export interface ReferralEvent {
  id: string;
  referrerCompanyId: string;
  referredCompanyId: string;
  triggeredBy: string;       // "signup" | "first_payment"
  creditsAwarded: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const AFFILIATE_PATH = process.env.HELIX_AFFILIATE_PATH ?? "/etc/helix/data/affiliates.json";

interface AffiliateStore {
  accounts: Array<[string, AffiliateAccount]>;
  events: ReferralEvent[];
}

const affiliateAccounts = new Map<string, AffiliateAccount>();
const referralEvents: ReferralEvent[] = [];
// secondary index: referral code → companyId
const codeIndex = new Map<string, string>();

export async function loadAffiliateStore(): Promise<void> {
  try {
    const raw = await fs.readFile(AFFILIATE_PATH, "utf8");
    const data = JSON.parse(raw) as AffiliateStore;
    for (const [id, account] of data.accounts ?? []) {
      affiliateAccounts.set(id, account);
      codeIndex.set(account.referralCode, id);
    }
    for (const evt of data.events ?? []) {
      referralEvents.push(evt);
    }
  } catch {
    // file may not exist on first run — silently skip
  }
}

async function saveAffiliateStore(): Promise<void> {
  try {
    const dir = path.dirname(AFFILIATE_PATH);
    await fs.mkdir(dir, { recursive: true });
    const data: AffiliateStore = {
      accounts: Array.from(affiliateAccounts.entries()),
      events: referralEvents,
    };
    await fs.writeFile(AFFILIATE_PATH, JSON.stringify(data, null, 2));
  } catch {
    // never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateCode(companyId: string): string {
  // 4 chars from companyId + 4 random hex chars — 8 chars total
  const prefix = companyId.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0").toUpperCase();
  return `${prefix}${suffix}`;
}

const COMMISSION_RATES: Record<string, number> = {
  free:   0.10,
  pro:    0.15,
  agency: 0.20,
};

const USD_PER_CREDIT = 0.01;

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export function generateReferralCode(companyId: string): AffiliateAccount {
  const existing = affiliateAccounts.get(companyId);
  if (existing) return existing;

  // Ensure uniqueness
  let code = generateCode(companyId);
  let attempts = 0;
  while (codeIndex.has(code) && attempts < 20) {
    code = generateCode(companyId);
    attempts++;
  }

  const account: AffiliateAccount = {
    companyId,
    referralCode: code,
    referrals: [],
    totalEarned: 0,
    createdAt: new Date().toISOString(),
  };

  affiliateAccounts.set(companyId, account);
  codeIndex.set(code, companyId);
  saveAffiliateStore().catch(() => {});
  return account;
}

export function recordReferral(code: string, newCompanyId: string): boolean {
  const referrerCompanyId = codeIndex.get(code.toUpperCase());
  if (!referrerCompanyId) return false;
  if (referrerCompanyId === newCompanyId) return false; // no self-referral

  const referrer = affiliateAccounts.get(referrerCompanyId);
  if (!referrer) return false;

  // Add to referrer's list (idempotent)
  if (!referrer.referrals.includes(newCompanyId)) {
    referrer.referrals.push(newCompanyId);
  }

  // Mark new company's referredBy (create affiliate account if needed)
  let newAccount = affiliateAccounts.get(newCompanyId);
  if (!newAccount) {
    newAccount = generateReferralCode(newCompanyId);
  }
  if (!newAccount.referredBy) {
    newAccount.referredBy = referrerCompanyId;
  }

  saveAffiliateStore().catch(() => {});
  return true;
}

export async function processCommission(
  referredCompanyId: string,
  paymentAmountUsd: number,
): Promise<void> {
  const referred = affiliateAccounts.get(referredCompanyId);
  if (!referred?.referredBy) return;

  const referrerCompanyId = referred.referredBy;
  const referrerAccount = affiliateAccounts.get(referrerCompanyId);
  if (!referrerAccount) return;

  // Look up referrer's credit tier for commission rate
  const creditAccount = getCreditSummary(referrerCompanyId);
  const rate = COMMISSION_RATES[creditAccount.tier] ?? COMMISSION_RATES.free;
  const creditsAwarded = Math.floor((paymentAmountUsd * rate) / USD_PER_CREDIT);

  if (creditsAwarded <= 0) return;

  await topUpCredits(referrerCompanyId, creditsAwarded, "affiliate_commission");

  referrerAccount.totalEarned += creditsAwarded;

  const evt: ReferralEvent = {
    id: randomUUID(),
    referrerCompanyId,
    referredCompanyId,
    triggeredBy: "first_payment",
    creditsAwarded,
    timestamp: new Date().toISOString(),
  };
  referralEvents.push(evt);

  saveAffiliateStore().catch(() => {});
}

export function getAffiliateStats(
  companyId: string,
): { account: AffiliateAccount | null; events: ReferralEvent[] } {
  const account = affiliateAccounts.get(companyId) ?? null;
  const events = referralEvents.filter(
    (e) => e.referrerCompanyId === companyId || e.referredCompanyId === companyId,
  );
  return { account, events };
}
