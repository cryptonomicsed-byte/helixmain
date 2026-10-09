/**
 * costLog — in-memory ring buffer for LLM cost tracking.
 *
 * Max 10,000 entries. Oldest entry is overwritten when the buffer is full.
 */

export interface CostEntry {
  provider: string;
  model: string;
  operationType: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  timestamp: string;
}

const MAX_ENTRIES = 10_000;

class CostLog {
  private entries: CostEntry[] = [];
  private head = 0; // ring-buffer write cursor

  logCost(entry: CostEntry): void {
    if (this.entries.length < MAX_ENTRIES) {
      this.entries.push(entry);
    } else {
      this.entries[this.head] = entry;
      this.head = (this.head + 1) % MAX_ENTRIES;
    }
  }

  getCostSummary(): {
    byProvider: Record<string, number>;
    byOperation: Record<string, number>;
    totalUsd: number;
    entries: CostEntry[];
  } {
    const byProvider: Record<string, number> = {};
    const byOperation: Record<string, number> = {};
    let totalUsd = 0;

    for (const e of this.entries) {
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.costUsd;
      byOperation[e.operationType] = (byOperation[e.operationType] ?? 0) + e.costUsd;
      totalUsd += e.costUsd;
    }

    return { byProvider, byOperation, totalUsd, entries: [...this.entries] };
  }

  exportCostLog(): CostEntry[] {
    return [...this.entries];
  }
}

export const costLog = new CostLog();
export function logCost(entry: CostEntry): void {
  costLog.logCost(entry);
}
