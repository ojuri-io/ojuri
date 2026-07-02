import { injectable } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { GroundTruthSource } from "@shared/enums/ground-truth-source.enum";
import InvalidLabelBatchError from "@shared/error/invalid-label-batch.error";
import LabelRepo from "../repositories/label.repo";
import { IngestLabelsResponseDto, LabelDto } from "../dtos/label.dto";
import { LabelBatchValidation } from "./label.types";

const log = createServiceLogger("LabelService");

export const MAX_LABEL_BATCH = 1000;
const CHUNK_SIZE = 500;

const VALID_SOURCES = new Set<string>(Object.values(GroundTruthSource));

/**
 * Pure validation + normalisation. Duplicate transaction_ids collapse
 * last-wins so an adopter can send "disputed then confirmed" in one
 * batch without a non-deterministic outcome.
 */
export function validateLabelBatch(input: unknown): LabelBatchValidation {
  const errors: string[] = [];
  const body = input as { labels?: unknown };

  if (!body || !Array.isArray(body.labels)) {
    return { labels: [], errors: ["body must be { labels: [...] }"] };
  }
  if (body.labels.length === 0) {
    return { labels: [], errors: ["labels must not be empty"] };
  }
  if (body.labels.length > MAX_LABEL_BATCH) {
    return { labels: [], errors: [`labels must contain at most ${MAX_LABEL_BATCH} entries`] };
  }

  const byTransactionId = new Map<string, LabelDto>();
  body.labels.forEach((raw, i) => {
    const label = raw as Partial<LabelDto>;
    if (typeof label?.transaction_id !== "string" || label.transaction_id.trim() === "") {
      errors.push(`labels[${i}]: transaction_id is required`);
      return;
    }
    if (typeof label.is_fraud !== "boolean") {
      errors.push(`labels[${i}]: is_fraud must be a boolean`);
      return;
    }
    if (typeof label.source !== "string" || !VALID_SOURCES.has(label.source)) {
      errors.push(
        `labels[${i}]: source must be one of ${[...VALID_SOURCES].join(", ")}`,
      );
      return;
    }
    byTransactionId.set(label.transaction_id.trim(), {
      transaction_id: label.transaction_id.trim(),
      is_fraud: label.is_fraud,
      source: label.source as GroundTruthSource,
    });
  });

  return { labels: [...byTransactionId.values()], errors };
}

@injectable()
class LabelService {
  constructor(private readonly repo: LabelRepo) {}

  async ingest(input: unknown, recordedBy: string): Promise<IngestLabelsResponseDto> {
    const { labels, errors } = validateLabelBatch(input);
    if (errors.length > 0) {
      throw new InvalidLabelBatchError(errors);
    }

    const matched = new Set<string>();
    for (let i = 0; i < labels.length; i += CHUNK_SIZE) {
      const applied = await this.repo.applyLabels(labels.slice(i, i + CHUNK_SIZE), recordedBy);
      for (const id of applied) matched.add(id);
    }

    const unmatched = labels
      .map((l) => l.transaction_id)
      .filter((id) => !matched.has(id));

    log.info("ingest", "Ground-truth labels applied", {
      received: labels.length,
      applied: matched.size,
      unmatched: unmatched.length,
      recordedBy,
    });

    return { received: labels.length, applied: matched.size, unmatched };
  }
}

export default LabelService;
