import { createServiceLogger } from "@utils/service-logger";
import { TransactionEvent, VelocityMetrics } from "./types";

const log = createServiceLogger("VelocityService");

interface TransactionRecord {
  timestamp: number;
  amount: number;
  type: string;
}

class VelocityService {
  private userTransactions: Map<string, TransactionRecord[]> = new Map();

  private readonly ONE_HOUR = 60 * 60 * 1000;
  private readonly ONE_DAY = 24 * 60 * 60 * 1000;
  private readonly SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  private readonly THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  private readonly MAX_TRANSACTIONS_PER_USER = 1000;

  constructor() {
    this.startPeriodicCleanup();
  }

  recordTransaction(event: TransactionEvent): void {
    const record: TransactionRecord = {
      timestamp: event.timestamp,
      amount: event.amount,
      type: event.transaction_type,
    };

    if (!this.userTransactions.has(event.sender_id)) {
      this.userTransactions.set(event.sender_id, []);
    }

    const transactions = this.userTransactions.get(event.sender_id)!;
    transactions.push(record);

    if (transactions.length > this.MAX_TRANSACTIONS_PER_USER) {
      transactions.shift();
    }
  }

  calculateMetrics(userId: string, currentTimestamp: number = Date.now()): VelocityMetrics {
    const transactions = this.userTransactions.get(userId);

    if (!transactions || transactions.length === 0) {
      return this.getDefaultMetrics();
    }

    const sorted = [...transactions].sort((a, b) => b.timestamp - a.timestamp);

    const velocity1h = this.countInWindow(sorted, currentTimestamp, this.ONE_HOUR);
    const velocity24h = this.countInWindow(sorted, currentTimestamp, this.ONE_DAY);
    const velocity7d = this.countInWindow(sorted, currentTimestamp, this.SEVEN_DAYS);

    const thirtyDayTransactions = this.filterByWindow(sorted, currentTimestamp, this.THIRTY_DAYS);
    const { avg: avgAmount30d, std: stdAmount30d } =
      this.calculateAmountStats(thirtyDayTransactions);

    const timeSinceLastTxn = sorted.length > 0 ? currentTimestamp - sorted[0]!.timestamp : 0;

    return {
      velocity_1h: velocity1h,
      velocity_24h: velocity24h,
      velocity_7d: velocity7d,
      avg_amount_30d: avgAmount30d,
      std_amount_30d: stdAmount30d,
      time_since_last_txn: Math.floor(timeSinceLastTxn / 1000),
    };
  }

  private countInWindow(
    transactions: TransactionRecord[],
    currentTime: number,
    windowMs: number
  ): number {
    const cutoff = currentTime - windowMs;
    let count = 0;

    for (const txn of transactions) {
      if (txn.timestamp >= cutoff) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  private filterByWindow(
    transactions: TransactionRecord[],
    currentTime: number,
    windowMs: number
  ): TransactionRecord[] {
    const cutoff = currentTime - windowMs;
    return transactions.filter((txn) => txn.timestamp >= cutoff);
  }

  private calculateAmountStats(transactions: TransactionRecord[]): { avg: number; std: number } {
    if (transactions.length === 0) {
      return { avg: 0, std: 0 };
    }

    const sum = transactions.reduce((acc, txn) => acc + txn.amount, 0);
    const avg = sum / transactions.length;

    if (transactions.length === 1) {
      return { avg, std: 0 };
    }

    const squaredDiffs = transactions.map((txn) => Math.pow(txn.amount - avg, 2));
    const avgSquaredDiff = squaredDiffs.reduce((acc, val) => acc + val, 0) / transactions.length;
    const std = Math.sqrt(avgSquaredDiff);

    return { avg: Math.round(avg * 100) / 100, std: Math.round(std * 100) / 100 };
  }

  private getDefaultMetrics(): VelocityMetrics {
    return {
      velocity_1h: 0,
      velocity_24h: 0,
      velocity_7d: 0,
      avg_amount_30d: 0,
      std_amount_30d: 0,
      time_since_last_txn: 0,
    };
  }

  private startPeriodicCleanup(): void {
    setInterval(() => {
      this.cleanupOldTransactions();
    }, this.ONE_HOUR);
  }

  private cleanupOldTransactions(): void {
    const cutoff = Date.now() - this.THIRTY_DAYS;
    let cleanedUsers = 0;
    let cleanedTransactions = 0;

    for (const [userId, transactions] of this.userTransactions.entries()) {
      const filtered = transactions.filter((txn) => txn.timestamp >= cutoff);

      if (filtered.length !== transactions.length) {
        cleanedTransactions += transactions.length - filtered.length;
        cleanedUsers++;

        if (filtered.length === 0) {
          this.userTransactions.delete(userId);
        } else {
          this.userTransactions.set(userId, filtered);
        }
      }
    }

    if (cleanedTransactions > 0) {
      log.info("cleanupOldTransactions", "Cleaned up old transactions", { cleanedUsers, cleanedTransactions });
    }
  }

  getStats(): { totalUsers: number; totalTransactions: number } {
    let totalTransactions = 0;
    for (const transactions of this.userTransactions.values()) {
      totalTransactions += transactions.length;
    }

    return {
      totalUsers: this.userTransactions.size,
      totalTransactions,
    };
  }
}

export const velocityService = new VelocityService();
export default VelocityService;
