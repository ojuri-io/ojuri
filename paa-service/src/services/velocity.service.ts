import appConfig from "@config/app.config";
import { createServiceLogger } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { TransactionEvent, VelocityMetrics, PairVelocityMetrics } from "./types";

const log = createServiceLogger("VelocityService");

interface TransactionRecord {
  timestamp: number;
  amount: number;
  type: string;
  receiver: string;
}

class VelocityService {
  private userTransactions: Map<string, TransactionRecord[]> = new Map();

  private readonly ONE_MINUTE = 60 * 1000;
  private readonly FIVE_MINUTES = 5 * 60 * 1000;
  private readonly FIFTEEN_MINUTES = 15 * 60 * 1000;
  private readonly ONE_HOUR = 60 * 60 * 1000;
  private readonly ONE_DAY = 24 * 60 * 60 * 1000;
  private readonly SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  private readonly THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  // Memory backstop only. Retention is time-based: a 1000-record FIFO
  // against 30-day windows truncated exactly the highest-velocity
  // senders — the population fraud detection cares most about — so
  // amount_mean_30d and velocity_7d were computed on a partial tail.
  private readonly maxTransactionsPerUser: number;

  constructor() {
    this.maxTransactionsPerUser = appConfig.paa.maxTransactionsPerUser;
    this.startPeriodicCleanup();
  }

  recordTransaction(event: TransactionEvent): void {
    const record: TransactionRecord = {
      timestamp: event.timestamp,
      amount: event.amount,
      type: event.transaction_type,
      receiver: event.receiver_id,
    };

    let transactions = this.userTransactions.get(event.sender_id);
    if (!transactions) {
      transactions = [];
      this.userTransactions.set(event.sender_id, transactions);
    }

    this.insertAscending(transactions, record);
    this.evictOutOfWindow(transactions, record.timestamp);
  }

  // Kept sorted on write so reads never pay a sort, and so a late-
  // arriving event is placed by its timestamp instead of landing at the
  // tail and evicting the newest record.
  private insertAscending(transactions: TransactionRecord[], record: TransactionRecord): void {
    const last = transactions[transactions.length - 1];
    if (!last || record.timestamp >= last.timestamp) {
      transactions.push(record);
      return;
    }
    let lo = 0;
    let hi = transactions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (transactions[mid]!.timestamp <= record.timestamp) lo = mid + 1;
      else hi = mid;
    }
    transactions.splice(lo, 0, record);
  }

  private evictOutOfWindow(transactions: TransactionRecord[], now: number): void {
    const cutoff = now - this.THIRTY_DAYS;
    let stale = 0;
    while (stale < transactions.length && transactions[stale]!.timestamp < cutoff) stale++;
    if (stale > 0) transactions.splice(0, stale);

    const overflow = transactions.length - this.maxTransactionsPerUser;
    if (overflow > 0) {
      transactions.splice(0, overflow);
      metricsService.recordVelocityTruncation(overflow);
    }
  }

  calculateMetrics(userId: string, currentTimestamp: number = Date.now()): VelocityMetrics {
    const transactions = this.userTransactions.get(userId);

    if (!transactions || transactions.length === 0) {
      return this.getDefaultMetrics();
    }

    // Stored ascending; every helper below expects newest-first.
    const sorted = transactions.slice().reverse();

    const velocity1m = this.countInWindow(sorted, currentTimestamp, this.ONE_MINUTE);
    const velocity5m = this.countInWindow(sorted, currentTimestamp, this.FIVE_MINUTES);
    const velocity15m = this.countInWindow(sorted, currentTimestamp, this.FIFTEEN_MINUTES);
    const velocity1h = this.countInWindow(sorted, currentTimestamp, this.ONE_HOUR);
    const velocity24h = this.countInWindow(sorted, currentTimestamp, this.ONE_DAY);
    const velocity7d = this.countInWindow(sorted, currentTimestamp, this.SEVEN_DAYS);

    const dayTransactions = this.filterByWindow(sorted, currentTimestamp, this.ONE_DAY);
    const weekTransactions = this.filterByWindow(sorted, currentTimestamp, this.SEVEN_DAYS);
    const thirtyDayTransactions = this.filterByWindow(sorted, currentTimestamp, this.THIRTY_DAYS);

    const { avg: avgAmount24h } = this.calculateAmountStats(dayTransactions);
    const maxAmount24h = dayTransactions.reduce((max, txn) => Math.max(max, txn.amount), 0);
    const { avg: avgAmount30d, std: stdAmount30d } =
      this.calculateAmountStats(thirtyDayTransactions);

    const timeSinceLastTxn = sorted.length > 0 ? currentTimestamp - sorted[0]!.timestamp : 0;

    return {
      velocity_1m: velocity1m,
      velocity_5m: velocity5m,
      velocity_15m: velocity15m,
      velocity_1h: velocity1h,
      velocity_24h: velocity24h,
      velocity_7d: velocity7d,
      amount_mean_24h: avgAmount24h,
      amount_max_24h: maxAmount24h,
      avg_amount_30d: avgAmount30d,
      std_amount_30d: stdAmount30d,
      unique_receivers_24h: this.countUniqueReceivers(dayTransactions),
      unique_receivers_7d: this.countUniqueReceivers(weekTransactions),
      hour_dev_from_norm: this.hourDeviationFromNorm(thirtyDayTransactions, currentTimestamp),
      time_since_last_txn: Math.floor(timeSinceLastTxn / 1000),
    };
  }

  /**
   * (sender → receiver) pair metrics from the in-memory buffers. Round
   * trips pair a forward send with a reverse send inside the window —
   * min(forward, reverse) counts completed back-and-forth cycles.
   */
  calculatePairMetrics(
    senderId: string,
    receiverId: string,
    currentTimestamp: number = Date.now()
  ): PairVelocityMetrics {
    const forward = (this.userTransactions.get(senderId) ?? [])
      .filter((txn) => txn.receiver === receiverId)
      .reverse();
    const reverse = (this.userTransactions.get(receiverId) ?? []).filter(
      (txn) => txn.receiver === senderId
    );

    const forward30d = this.filterByWindow(forward, currentTimestamp, this.THIRTY_DAYS);
    const reverse30d = this.filterByWindow(reverse, currentTimestamp, this.THIRTY_DAYS);
    const { avg: amountMean30d } = this.calculateAmountStats(forward30d);

    const secondsSincePrevSend =
      forward.length >= 2
        ? Math.floor((forward[0]!.timestamp - forward[1]!.timestamp) / 1000)
        : null;

    return {
      forwardCount30d: forward30d.length,
      amountMean30d,
      roundTripCount30d: Math.min(forward30d.length, reverse30d.length),
      secondsSincePrevSend,
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

  private countUniqueReceivers(transactions: TransactionRecord[]): number {
    const receivers = new Set<string>();
    for (const txn of transactions) {
      if (txn.receiver) receivers.add(txn.receiver);
    }
    return receivers.size;
  }

  /**
   * Circular distance (in hours, 0–12) between the current hour and
   * the circular mean of the sender's recent transacting hours. UTC on
   * both sides — RDA's calendar features use the same clock.
   */
  private hourDeviationFromNorm(
    transactions: TransactionRecord[],
    currentTimestamp: number
  ): number {
    if (transactions.length === 0) return 0;

    let sinSum = 0;
    let cosSum = 0;
    for (const txn of transactions) {
      const angle = (new Date(txn.timestamp).getUTCHours() / 24) * 2 * Math.PI;
      sinSum += Math.sin(angle);
      cosSum += Math.cos(angle);
    }
    if (sinSum === 0 && cosSum === 0) return 0;

    const meanAngle = Math.atan2(sinSum, cosSum);
    const typicalHour = ((meanAngle / (2 * Math.PI)) * 24 + 24) % 24;
    const currentHour = new Date(currentTimestamp).getUTCHours();

    const rawDistance = Math.abs(currentHour - typicalHour);
    const distance = Math.min(rawDistance, 24 - rawDistance);
    return Math.round(distance * 100) / 100;
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
      velocity_1m: 0,
      velocity_5m: 0,
      velocity_15m: 0,
      velocity_1h: 0,
      velocity_24h: 0,
      velocity_7d: 0,
      amount_mean_24h: 0,
      amount_max_24h: 0,
      avg_amount_30d: 0,
      std_amount_30d: 0,
      unique_receivers_24h: 0,
      unique_receivers_7d: 0,
      hour_dev_from_norm: 0,
      time_since_last_txn: 0,
    };
  }

  private startPeriodicCleanup(): void {
    const timer = setInterval(() => {
      this.cleanupOldTransactions();
    }, this.ONE_HOUR);
    if (timer.unref) timer.unref();
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
