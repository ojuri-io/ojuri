import appConfig from "@config/app.config";
import { metricsService } from "@utils/metrics";

// Kafka is at-least-once and offsets commit after processing, so a
// replay re-applies events to graph and velocity counters that already
// counted them — and unlike the Postgres upserts, that inflation is
// permanent. Seeded on restart from worker.ts's hydration replay.
class ProcessedEventsService {
  private readonly seen = new Set<string>();
  private readonly ring: string[];
  private next = 0;

  constructor(capacity: number = appConfig.paa.dedupeWindowSize) {
    this.ring = new Array(Math.max(1, capacity));
  }

  /** True when this id has not been seen inside the window. */
  markIfNew(transactionId: string | undefined | null): boolean {
    if (!transactionId) return true;
    if (this.seen.has(transactionId)) {
      metricsService.recordDuplicateEventSkipped();
      return false;
    }

    const evicted = this.ring[this.next];
    if (evicted !== undefined) this.seen.delete(evicted);

    this.ring[this.next] = transactionId;
    this.next = (this.next + 1) % this.ring.length;
    this.seen.add(transactionId);
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
    this.ring.fill(undefined as unknown as string);
    this.next = 0;
  }
}

export const processedEvents = new ProcessedEventsService();
export default ProcessedEventsService;
