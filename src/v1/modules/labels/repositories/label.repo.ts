import { injectable } from "tsyringe";
import { Model } from "objection";
import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { LabelDto } from "../dtos/label.dto";
import { LabelWriter } from "../services/label.types";

@injectable()
class LabelRepo implements LabelWriter {
  async applyLabels(labels: LabelDto[], recordedBy: string): Promise<string[]> {
    if (labels.length === 0) return [];

    const knex = Model.knex();
    const placeholders = labels.map(() => "(?, ?::boolean, ?)").join(", ");
    const bindings = labels.flatMap((l) => [l.transaction_id, l.is_fraud, l.source]);

    const result = await knex.raw(
      `UPDATE "${DB_TABLES.TRANSACTIONS}" AS t
          SET "groundTruthFraud" = v.is_fraud,
              "groundTruthSource" = v.source,
              "groundTruthRecordedAt" = NOW(),
              "groundTruthRecordedBy" = ?
         FROM (VALUES ${placeholders}) AS v(transaction_id, is_fraud, source)
        WHERE t."transactionId" = v.transaction_id
    RETURNING t."transactionId"`,
      [recordedBy, ...bindings],
    );

    const rows = (result as { rows?: Array<{ transactionId: string }> }).rows ?? [];
    return rows.map((r) => r.transactionId);
  }
}

export default LabelRepo;
