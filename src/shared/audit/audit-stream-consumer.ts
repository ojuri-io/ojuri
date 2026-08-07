import { Kafka, Consumer } from "kafkajs";
import { singleton } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import AuditRowFactory, { AuditInsertRow } from "./factories/audit-row.factory";
import { DecisionAudit } from "./model/decision-audit.model";
import { AuditEventPayload } from "./decision-audit.types";

const log = createServiceLogger("AuditStreamConsumer");

const GROUP_ID = process.env.AUDIT_CONSUMER_GROUP || "audit-writer";

@singleton()
class AuditStreamConsumer {
  private consumer: Consumer | null = null;
  private inserted = 0;

  async start(): Promise<void> {
    const kafka = new Kafka({
      clientId: `${appConfig.kafka.clientId}-audit`,
      brokers: appConfig.kafka.brokers,
    });
    this.consumer = kafka.consumer({ groupId: GROUP_ID });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: appConfig.kafka.topic });

    await this.consumer.run({
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        const rows: AuditInsertRow[] = [];
        for (const message of batch.messages) {
          const payload = this.parseAuditPayload(message.value);
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
        await heartbeat();
      },
    });

    log.success("start", "Audit stream consumer running", {
      topic: appConfig.kafka.topic,
      groupId: GROUP_ID,
    });
  }

  private parseAuditPayload(value: Buffer | null): AuditEventPayload | null {
    if (!value) return null;
    try {
      const event = JSON.parse(value.toString()) as { audit?: AuditEventPayload };
      return event.audit ?? null;
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

  async stop(): Promise<void> {
    if (!this.consumer) return;
    await this.consumer.disconnect();
    this.consumer = null;
    log.info("stop", "Audit stream consumer stopped", { inserted: this.inserted });
  }
}

export default AuditStreamConsumer;
