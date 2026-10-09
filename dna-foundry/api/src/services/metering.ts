/**
 * metering — credit ledger, quota enforcement, refund-on-failure.
 *
 * Optimistic deduction: credits are deducted before the operation runs.
 * On failure, caller must call refundCredits(usageEntry.id).
 * New companies start on the free tier with 50 credits.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreditAccount {
  companyId: string;
  balance: number;         // credits remaining
  tier: "free" | "pro" | "agency";
  usageLog: UsageEntry[];
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

const CREDIT_COSTS: Record<string, number> = {
  extraction:           10,
  compilation:           5,
  content_generation:    8,
  image_generation:     15,
  sales_lead_hunt:      20,
  outreach_generation:  10,
  intel_battle:         12,
  greeting_compile:      3,
};

// USD cost-per-credit (rough: $0.01 / credit)
const USD_PER_CREDIT = 0.01;

const TIER_LIMITS: Record<CreditAccount["tier"], { monthly: number; daily: number }> = {
  free:   { monthly: 100,   daily: 20  },
  pro:    { monthly: 1000,  daily: 100 },
  agency: { monthly: 10000, daily: 500 },
};

const FREE_STARTER_BALANCE = 50;

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
  return entries
    .filter((e) => !e.refunded && new Date(e.timestamp) >= since)
    .reduce((sum, e) => sum + e.creditsDeducted, 0);
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export function initAccount(companyId: string): CreditAccount {
  const existing = accountStore.get(companyId);
  if (existing) return existing;

  const account: CreditAccount = {
    companyId,
    balance: FREE_STARTER_BALANCE,
    tier: "free",
    usageLog: [],
  };
  accountStore.set(companyId, account);
  return account;
}

export function getCreditSummary(companyId: string): CreditAccount {
  const account = getAccount(companyId);
  if (!account) return initAccount(companyId);
  return account;
}

export function checkQuota(
  companyId: string,
): { allowed: boolean; remaining: number; resetAt: string } {
  const account = getAccount(companyId) ?? initAccount(companyId);
  const limits = TIER_LIMITS[account.tier];

  const dayStart = startOfDayUtc();
  const monthStart = startOfMonthUtc();

  const usedToday = usageInWindow(account.usageLog, dayStart);
  const usedThisMonth = usageInWindow(account.usageLog, monthStart);

  const remainingBalance = account.balance;
  const remainingDaily = limits.daily - usedToday;
  const remainingMonthly = limits.monthly - usedThisMonth;

  const remaining = Math.min(remainingBalance, remainingDaily, remainingMonthly);
  const allowed = remaining > 0;

  // Reset at: next midnight UTC
  const resetAt = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();

  return { allowed, remaining: Math.max(0, remaining), resetAt };
}

export async function deductCredits(
  companyId: string,
  operationType: string,
): Promise<UsageEntry> {
  const quota = checkQuota(companyId);
  if (!quota.allowed) {
    throw new QuotaExceeded(
      `Quota exceeded for company ${companyId}. Remaining: ${quota.remaining}. Resets at: ${quota.resetAt}`,
    );
  }

  const account = getAccount(companyId) ?? initAccount(companyId);
  const creditsDeducted = CREDIT_COSTS[operationType] ?? 5;

  if (account.balance < creditsDeducted) {
    throw new QuotaExceeded(
      `Insufficient credits for company ${companyId}. Balance: ${account.balance}, required: ${creditsDeducted}`,
    );
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
      return;
    }
  }
  throw new Error(`UsageEntry not found: ${usageEntryId}`);
}
