import appConfig from "@config/app.config";
import { metricsService } from "@utils/metrics";

/**
 * Kafka delivery is at-least-once and PAA commits offsets after
 * processing, so a crash between the in-memory graph/velocity update and
 * the commit replays events that were already counted. Postgres upserts
 * are conflict-safe; edge weights, velocity windows and node counters are
 * not — a replay permanently inflates them. The producer's LevelDB buffer
 * replay creates the same exposure.
 *
 * Bounded FIFO of recently-seen transaction ids. Memory-only by design:
 * a restart re-hydrates graph state from Postgres/Redis anyway, so the
 * window only needs to cover a rebalance or buffer replay, not a cold
 * boot.
 */
class ProcessedEventsService {
  private seen: Set<string> = new Set();
  private order: string[] = [];
  private readonly capacity: number;

  constructor(capacity: number = appConfig.paa.dedupeWindowSize) {
    this.capacity = Math.max(1, capacity);
  }

  /** True when this id has not been processed inside the window. */
  markIfNew(transactionId: string | undefined | null): boolean {
    if (!transactionId) return true;
    if (this.seen.has(transactionId)) {
      metricsService.recordDuplicateEventSkipped();
      return false;
    }

    this.seen.add(transactionId);
    this.order.push(transactionId);
    if (this.order.length > this.capacity) {
      const evicted = this.order.splice(0, this.order.length - this.capacity);
      for (const id of evicted) this.seen.delete(id);
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
    this.order = [];
  }
}

export const processedEvents = new ProcessedEventsService();
export default ProcessedEventsService;
