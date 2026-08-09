import { Kafka, Consumer } from "kafkajs";
import { singleton } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import AuditRowFactory, { AuditInsertRow } from "./factories/audit-row.factory";
import { DecisionAudit } from "./model/decision-audit.model";
import { AuditEnrichmentEvent, AuditEventPayload } from "./decision-audit.types";

const log = createServiceLogger("AuditStreamConsumer");

const GROUP_ID = process.env.AUDIT_CONSUMER_GROUP || "audit-writer";
const PENDING_RETRY_MS = 2000;
const PENDING_TTL_MS = 60000;
const PENDING_CAP = 10000;

type PendingEnrichment = AuditEnrichmentEvent & { firstSeen: number };

@singleton()
class AuditStreamConsumer {
  private consumer: Consumer | null = null;
  private inserted = 0;
  private enriched = 0;
  // Enrichments can beat their row across topics — parked here and
  // retried until the insert lands or the TTL expires.
  private pending: PendingEnrichment[] = [];
  private retryTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    const kafka = new Kafka({
      clientId: `${appConfig.kafka.clientId}-audit`,
      brokers: appConfig.kafka.brokers,
    });
    this.consumer = kafka.consumer({ groupId: GROUP_ID });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: appConfig.kafka.topic });
    await this.consumer.subscribe({ topic: appConfig.kafka.auditEnrichTopic });

    await this.consumer.run({
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        if (batch.topic === appConfig.kafka.auditEnrichTopic) {
          await this.handleEnrichmentBatch(batch.messages, resolveOffset);
        } else {
          await this.handleDecisionBatch(batch.messages, resolveOffset);
        }
        await heartbeat();
      },
    });

    this.retryTimer = setInterval(() => {
      this.retryPending().catch((err) =>
        log.warn("retryPending", "Pending enrichment retry failed", { err: String(err) })
      );
    }, PENDING_RETRY_MS);
    if (this.retryTimer.unref) this.retryTimer.unref();

    log.success("start", "Audit stream consumer running", {
      topics: [appConfig.kafka.topic, appConfig.kafka.auditEnrichTopic],
      groupId: GROUP_ID,
    });
  }

  private async handleDecisionBatch(
    messages: Array<{ value: Buffer | null; offset: string }>,
    resolveOffset: (offset: string) => void,
  ): Promise<void> {
    const rows: AuditInsertRow[] = [];
    for (const message of messages) {
      const payload = this.parse<{ audit?: AuditEventPayload }>(message.value)?.audit;
      if (payload) {
        rows.push(AuditRowFactory.toInsertRow({ ...payload, id: payload.auditId }));
      }
      resolveOffset(message.offset);
    }
    if (rows.length > 0) {
      const knex = DecisionAudit.knex();
      await knex(DecisionAudit.tableName)
        .insert(rows)
        .onConflict(["tenantId", "transactionId"])
        .ignore();
      this.inserted += rows.length;
    }
  }

  private async handleEnrichmentBatch(
    messages: Array<{ value: Buffer | null; offset: string }>,
    resolveOffset: (offset: string) => void,
  ): Promise<void> {
    for (const message of messages) {
      const enrichment = this.parse<AuditEnrichmentEvent>(message.value);
      if (enrichment?.audit_id && enrichment.fields) {
        const applied = await this.applyEnrichment(enrichment);
        if (!applied) this.park(enrichment);
      }
      resolveOffset(message.offset);
    }
  }

  private async applyEnrichment(enrichment: AuditEnrichmentEvent): Promise<boolean> {
    const update = AuditRowFactory.toEnrichmentUpdate(enrichment.fields);
    if (Object.keys(update).length === 0) return true;
    const knex = DecisionAudit.knex();
    const updated = await knex(DecisionAudit.tableName)
      .where({ id: enrichment.audit_id })
      .update(update);
    if (updated > 0) this.enriched++;
    return updated > 0;
  }

  private park(enrichment: AuditEnrichmentEvent): void {
    if (this.pending.length >= PENDING_CAP) {
      log.warn("park", "Pending enrichment buffer full — dropping oldest", {});
      this.pending.shift();
    }
    this.pending.push({ ...enrichment, firstSeen: Date.now() });
  }

  private async retryPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const now = Date.now();
    const batch = this.pending;
    this.pending = [];
    for (const item of batch) {
      if (await this.applyEnrichment(item)) continue;
      if (now - item.firstSeen > PENDING_TTL_MS) {
        log.warn("retryPending", "Enrichment expired without a matching audit row", {
          auditId: item.audit_id,
        });
        continue;
      }
      this.pending.push(item);
    }
  }

  private parse<T>(value: Buffer | null): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value.toString()) as T;
    } catch (err) {
      log.warn("parse", "Unparseable message on audit stream — skipping", {
        err: String(err),
      });
      return null;
    }
  }

  insertedCount(): number {
    return this.inserted;
  }

  enrichedCount(): number {
    return this.enriched;
  }

  async stop(): Promise<void> {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.consumer) return;
    await this.consumer.disconnect();
    this.consumer = null;
    log.info("stop", "Audit stream consumer stopped", {
      inserted: this.inserted,
      enriched: this.enriched,
    });
  }
}

export default AuditStreamConsumer;
