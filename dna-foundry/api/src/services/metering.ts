/**
 * metering — credit ledger, quota enforcement, refund-on-failure.
 *
 * Optimistic deduction: credits are deducted before the operation runs.
 * On failure, caller must call refundCredits(usageEntry.id).
 * New companies start on the free tier with 100 credits, granted once at signup.
 */

import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { budgetCreditsFor } from "./settings";
import { isProvisionedCompany } from "./companies";
import { isAdminCompany } from "./admin";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreditAccount {
  companyId: string;
  balance: number;         // credits remaining
  tier: "free" | "pro" | "agency";
  usageLog: UsageEntry[];
  stripeCustomerId?: string;
}

export interface UsageEntry {
  id: string;
  timestamp: string;
  operationType: string;   // 'extraction', 'compilation', etc.
  creditsDeducted: number;
  costUsd: number;
  refunded: boolean;
  refundReason?: string;
}

// ---------------------------------------------------------------------------
// Cost tables
// ---------------------------------------------------------------------------

export const CREDIT_COSTS: Record<string, number> = {
  extraction:           5,
  compilation:           5,
  campaign_prd:         30,
  campaign_assets:      30,
  content_generation:   30,
  image_generation:     15,
  voice_sample:         15,
  voice_jingle:         25,
  greeting_compile:      3,
  sales_lead_hunt:      20,
  sales_qualify:        10,
  sales_qualify_bulk:   25,
  sales_outreach:       10,
  sales_review:         10,
  sales_close:          15,
  intel_battle:         12,
  playground_message:    5,
  site_generate:        40,
  plan_generate:        20,
};

// USD cost-per-credit (rough: $0.01 / credit)
const USD_PER_CREDIT = 0.01;

// The daily cap is a SOFT rate limit: checkQuota() allows an operation whenever
// ANY credit remains today (remaining > 0) — it does NOT compare the operation's
// cost to what is left. So a single operation only needs some headroom, but a
// workflow spanning several operations needs the daily cap to EXCEED the
// workflow's total cost or it cannot finish in one day. The MONTHLY cap is the
// real budget. Free's old daily:20 let a funded company do one site_generate (40)
// but could not complete a campaign (PRD 30 + assets 30 = 60) without waiting for
// the next day. free 20->75, pro 100->150 so a whole workflow fits in a day.
export const TIER_LIMITS: Record<CreditAccount["tier"], { monthly: number; daily: number }> = {
  free:   { monthly: 100,   daily: 100 },
  pro:    { monthly: 1000,  daily: 150 },
  agency: { monthly: 10000, daily: 500 },
};

// Enforced at load so a cost edit can never silently make a whole workflow
// impossible to finish in one day.
{
  const priciestWorkflow = Math.max(60, ...Object.values(CREDIT_COSTS)); // campaign = PRD + assets
  for (const [tier, lim] of Object.entries(TIER_LIMITS)) {
    if (lim.daily < priciestWorkflow) {
      throw new Error(
        `tier '${tier}' daily cap ${lim.daily} is below the priciest workflow ${priciestWorkflow} — that workflow could not complete in one day`
      );
    }
  }
}

const FREE_TIER_GRANT = TIER_LIMITS.free.monthly; // 100 — granted ONCE, at signup

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const ACCOUNTS_PATH = process.env.HELIX_ACCOUNTS_PATH ?? "/etc/helix/data/accounts.json";

export async function loadAccountStore(): Promise<void> {
  try {
    const raw = await fs.readFile(ACCOUNTS_PATH, "utf8");
    const data = JSON.parse(raw) as Array<[string, CreditAccount]>;
    for (const [id, account] of data) {
      accountStore.set(id, account);
    }
  } catch {
    // file may not exist on first run — silently skip
  }
}

async function saveAccountStore(): Promise<void> {
  try {
    const dir = path.dirname(ACCOUNTS_PATH);
    await fs.mkdir(dir, { recursive: true });
    const data = Array.from(accountStore.entries());
    await fs.writeFile(ACCOUNTS_PATH, JSON.stringify(data, null, 2));
  } catch {
    // never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class QuotaExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceeded";
  }
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const accountStore = new Map<string, CreditAccount>();

function getAccount(companyId: string): CreditAccount | null {
  return accountStore.get(companyId) ?? null;
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

function startOfDayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonthUtc(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function usageInWindow(entries: UsageEntry[], since: Date): number {
  // Only real SPEND counts. A top-up carries a NEGATIVE creditsDeducted, and
  // summing those in silently inflated the measured usage — a company that
  // topped up today effectively had its daily and monthly caps cancelled
  // (demo-barber's -600 of top-ups made usedToday -485, so its "20/day" limit
  // became ~505). Mirrors the creditsDeducted > 0 filter in the budget cap.
  return entries
    .filter((e) => !e.refunded && e.creditsDeducted > 0 && new Date(e.timestamp) >= since)
    .reduce((sum, e) => sum + e.creditsDeducted, 0);
}

/** Credits added ON TOP of the plan's own allowance — one-time packs and operator
 *  grants. Top-ups are stored as `operationType:"top_up"` with a NEGATIVE
 *  creditsDeducted and the source recorded in `refundReason`.
 *
 *  A SUBSCRIPTION grant is excluded: it upgrades the tier, and that tier already
 *  supplies the allowance, so counting it here would double it. The sum is
 *  monotonic, so it is a stable cap rather than a moving target. */
function extraCreditsBeyondPlan(entries: UsageEntry[]): number {
  return entries
    .filter(
      (e) =>
        e.operationType === "top_up" &&
        e.creditsDeducted < 0 &&
        e.refundReason !== "stripe_subscription",
    )
    .reduce((sum, e) => sum + -e.creditsDeducted, 0);
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export function initAccount(companyId: string): CreditAccount {
  const existing = accountStore.get(companyId);
  if (existing) return existing;

  // NEVER auto-create for an arbitrary id. This used to hand 100 free credits to
  // anyone who named a company in a request body — the account store was a money
  // printer. Only a PROVISIONED company gets an account: one that actually exists
  // on disk (self-serve signup or operator onboarding wrote its keys there). The
  // guard is "does this company exist", never "did the caller type this name".
  if (!isProvisionedCompany(companyId)) {
    throw new Error(`no credit account for unknown company: ${companyId}`);
  }

  const account: CreditAccount = {
    companyId,
    balance: FREE_TIER_GRANT,
    tier: "free",
    usageLog: [],
  };
  accountStore.set(companyId, account);
  saveAccountStore().catch(() => {});
  return account;
}

/** The account for a company, created only if the company is onboarded.
 *  Returns null otherwise — callers read that as "no credits", never as a crash. */
function accountFor(companyId: string): CreditAccount | null {
  const a = accountStore.get(companyId);
  if (a) return a;
  return isProvisionedCompany(companyId) ? initAccount(companyId) : null;
}

export function getCreditSummary(companyId: string): CreditAccount {
  return accountFor(companyId) ?? { companyId, balance: 0, tier: "free", usageLog: [] };
}

export function checkQuota(
  companyId: string,
): { allowed: boolean; remaining: number; resetAt: string; reason?: string } {
  const account = accountFor(companyId);
  const dayStart = startOfDayUtc();
  const resetAt = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
  if (!account) return { allowed: false, remaining: 0, resetAt };

  // The admin account is never blocked. This is driven by the on-disk allowlist,
  // never by anything in the request, so it cannot be claimed.
  if (isAdminCompany(companyId)) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt };
  }

  const limits = TIER_LIMITS[account.tier];
  const monthStart = startOfMonthUtc();

  const usedToday = usageInWindow(account.usageLog, dayStart);
  const usedThisMonth = usageInWindow(account.usageLog, monthStart);

  // Credits BOUGHT or GRANTED on top of the plan's own allowance raise BOTH caps,
  // so a purchased credit is always spendable. The free allowance still gates the
  // baseline and no tier upgrade is required to spend what you paid for — a "buy
  // credits" button that leaves you blocked is worse than no button at all.
  const extra = extraCreditsBeyondPlan(account.usageLog);
  const dailyCap = limits.daily + extra;
  const monthlyCap = limits.monthly + extra;

  const remainingBalance = account.balance;
  const remainingDaily = dailyCap - usedToday;
  const remainingMonthly = monthlyCap - usedThisMonth;

  const remaining = Math.min(remainingBalance, remainingDaily, remainingMonthly);

  // Say WHICH limit bound. "Quota exceeded … Remaining: -15" told a caller nothing
  // and read like a bug when they still had credits.
  let reason: string | undefined;
  if (remaining <= 0) {
    if (remainingBalance <= 0) reason = `credit balance is ${remainingBalance}`;
    else if (remainingMonthly <= 0) reason = `monthly cap reached (${usedThisMonth}/${monthlyCap} credits this month)`;
    else if (remainingDaily <= 0) reason = `daily cap reached (${usedToday}/${dailyCap} credits today)`;
  }

  return { allowed: remaining > 0, remaining: Math.max(0, remaining), resetAt, reason };
}

export async function deductCredits(
  companyId: string,
  operationType: string,
): Promise<UsageEntry> {
  // The admin account runs everything without spending. It still gets a usage
  // entry — with creditsDeducted 0 — so admin activity is visible in the same
  // ledger as everyone else's, and "unlimited" never means "unaudited".
  // `isAdminCompany` reads the allowlist from disk, so no request can claim this.
  if (isAdminCompany(companyId)) {
    const account = accountFor(companyId);
    const entry: UsageEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      operationType,
      creditsDeducted: 0,
      costUsd: 0,
      refunded: false,
      refundReason: "admin_unmetered",
    };
    if (account) {
      account.usageLog.push(entry);
      saveAccountStore().catch(() => {});
    }
    return entry;
  }

  const quota = checkQuota(companyId);
  if (!quota.allowed) {
    throw new QuotaExceeded(
      `Quota exceeded for company ${companyId}${quota.reason ? `: ${quota.reason}` : ""}. ` +
        `Remaining: ${quota.remaining}. Resets at: ${quota.resetAt}`,
    );
  }

  const account = accountFor(companyId);
  if (!account) throw new QuotaExceeded(`unknown company: ${companyId}`);
  const creditsDeducted = CREDIT_COSTS[operationType] ?? 5;

  if (account.balance < creditsDeducted) {
    throw new QuotaExceeded(
      `Insufficient credits for company ${companyId}. Balance: ${account.balance}, required: ${creditsDeducted}`,
    );
  }

  // Per-business monthly budget cap (0 = uncapped). Enforced here so the cap is
  // real, not a note in the UI.
  const cap = budgetCreditsFor(companyId);
  if (cap > 0) {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const spentThisMonth = account.usageLog
      .filter((e) => !e.refunded && e.timestamp.slice(0, 7) === month && e.creditsDeducted > 0)
      .reduce((s, e) => s + e.creditsDeducted, 0);
    if (spentThisMonth + creditsDeducted > cap) {
      throw new QuotaExceeded(
        `Monthly budget cap reached for company ${companyId}. Spent: ${spentThisMonth}/${cap} credits this month.`,
      );
    }
  }

  const entry: UsageEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    operationType,
    creditsDeducted,
    costUsd: creditsDeducted * USD_PER_CREDIT,
    refunded: false,
  };

  account.balance -= creditsDeducted;
  account.usageLog.push(entry);
  saveAccountStore().catch(() => {});
  return entry;
}

export async function refundCredits(usageEntryId: string): Promise<void> {
  for (const account of accountStore.values()) {
    const entry = account.usageLog.find((e) => e.id === usageEntryId);
    if (entry) {
      if (entry.refunded) return; // idempotent
      entry.refunded = true;
      entry.refundReason = "operation_failed";
      account.balance += entry.creditsDeducted;
      saveAccountStore().catch(() => {});
      return;
    }
  }
  throw new Error(`UsageEntry not found: ${usageEntryId}`);
}

export function getAccountStoreSize(): number {
  return accountStore.size;
}

export async function topUpCredits(
  companyId: string,
  credits: number,
  reason: string,
): Promise<UsageEntry> {
  const account = accountFor(companyId);
  if (!account) throw new Error(`cannot top up an unknown company: ${companyId}`);

  const entry: UsageEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    operationType: "top_up",
    creditsDeducted: -credits,   // negative = credit added
    costUsd: 0,
    refunded: false,
    refundReason: reason,
  };

  account.balance += credits;
  account.usageLog.push(entry);
  saveAccountStore().catch(() => {});
  return entry;
}

export function upgradeTier(companyId: string, tier: CreditAccount["tier"]): void {
  const account = accountFor(companyId);
  if (!account) throw new Error(`cannot upgrade an unknown company: ${companyId}`);
  account.tier = tier;
  saveAccountStore().catch(() => {});
}

export function setStripeCustomerId(companyId: string, customerId: string): void {
  const account = accountFor(companyId);
  if (!account) return;
  account.stripeCustomerId = customerId;
  saveAccountStore().catch(() => {});
}

export function getStripeCustomerId(companyId: string): string | null {
  return accountStore.get(companyId)?.stripeCustomerId ?? null;
}

/** Flush the account store to disk and await it.
 *
 *  The mutation helpers above save fire-and-forget (`.catch(() => {})`), which is
 *  right for the per-call hot path where a few ms of write latency would be paid on
 *  every AI call. It is WRONG for a payment webhook: there, a 200 tells Stripe the
 *  grant was accepted, so the write must have actually landed before we answer —
 *  otherwise a crash between the response and the flush loses a paid-for credit
 *  quietly. Callers that need that guarantee await this explicitly. */
export async function flushAccountStore(): Promise<void> {
  await saveAccountStore();
}

// ---------------------------------------------------------------------------
// Stripe pricing config
//
// ONE SOURCE OF TRUTH. These used to be two tables that disagreed: the ADVERTISED
// one promised Starter 500 and Pro 2000 while the ENFORCED TIER_LIMITS capped
// them at 100 and 1000. So the landing page and GET /billing/config over-promised
// by 5x and 2x, and a Stripe top-up handed over credits the account could never
// spend. TIER_LIMITS is the real one; the advertised table is now DERIVED from it,
// so the two cannot drift apart again.
//
// The free tier is named "Free", not "Starter": "Starter" collides with the paid
// DNA Starter offering and reads as though the $0 tier includes it. The Stripe
// priceId keeps its historical name (it is an external identifier, and the free
// tier is $0 so nothing checks it out).
// ---------------------------------------------------------------------------

export const TIER_PRICES: Record<string, { name: string; price: string; credits: number; priceId: string }> = {
  free:   { name: "Free",   price: "$0/mo",   credits: TIER_LIMITS.free.monthly,   priceId: "price_starter_monthly" },
  pro:    { name: "Pro",    price: "$49/mo",  credits: TIER_LIMITS.pro.monthly,    priceId: "price_pro_monthly" },
  agency: { name: "Agency", price: "$199/mo", credits: TIER_LIMITS.agency.monthly, priceId: "price_agency_monthly" },
};

/** What a successful Stripe payment grants, derived from TIER_PRICES so a price
 *  can never grant more than its tier can spend.
 *
 *  NOTE on refills: `invoice.payment_succeeded` fires on every renewal, which is
 *  what refills a PAID tier monthly. The free tier has no subscription, so its
 *  grant happens ONCE at signup and never repeats — "100 credits / month" would be
 *  as wrong as "500". TIER_LIMITS.monthly is a spend CAP, not a refill. */
export const PRICE_TO_CREDITS: Record<string, { credits: number; tier?: CreditAccount["tier"] }> = {
  [TIER_PRICES.free.priceId]:   { credits: TIER_PRICES.free.credits,   tier: "free" },
  [TIER_PRICES.pro.priceId]:    { credits: TIER_PRICES.pro.credits,    tier: "pro" },
  [TIER_PRICES.agency.priceId]: { credits: TIER_PRICES.agency.credits, tier: "agency" },
  // One-time credit packs (no tier change)
  "price_pack_spark":    { credits: 150 },
  "price_pack_boost":    { credits: 550 },
  "price_pack_power":    { credits: 1200 },
  "price_pack_agency":   { credits: 4000 },
};

export const CREDIT_PACKS: Array<{ name: string; price: string; credits: number; priceId: string }> = [
  { name: "Spark",  price: "$4.99",  credits: 150,  priceId: "price_pack_spark" },
  { name: "Boost",  price: "$14.99", credits: 550,  priceId: "price_pack_boost" },
  { name: "Power",  price: "$29.99", credits: 1200, priceId: "price_pack_power" },
  { name: "Agency", price: "$89.99", credits: 4000, priceId: "price_pack_agency" },
];
