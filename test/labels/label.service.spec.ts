import "reflect-metadata";
import LabelService, {
  MAX_LABEL_BATCH,
  validateLabelBatch,
} from "../../src/v1/modules/labels/services/label.service";
import LabelRepo from "../../src/v1/modules/labels/repositories/label.repo";
import InvalidLabelBatchError from "../../src/shared/error/invalid-label-batch.error";
import { GroundTruthSource } from "../../src/shared/enums/ground-truth-source.enum";

function label(id: string, isFraud = true, source = GroundTruthSource.CHARGEBACK) {
  return { transaction_id: id, is_fraud: isFraud, source };
}

describe("validateLabelBatch", () => {
  it("rejects a missing or non-array body", () => {
    expect(validateLabelBatch(undefined).errors).toHaveLength(1);
    expect(validateLabelBatch({ labels: "nope" }).errors).toHaveLength(1);
    expect(validateLabelBatch({ labels: [] }).errors).toEqual(["labels must not be empty"]);
  });

  it("rejects batches above the cap", () => {
    const labels = Array.from({ length: MAX_LABEL_BATCH + 1 }, (_, i) => label(`tx-${i}`));
    expect(validateLabelBatch({ labels }).errors[0]).toMatch(/at most/);
  });

  it("reports per-entry errors with indices", () => {
    const { errors } = validateLabelBatch({
      labels: [
        { transaction_id: "", is_fraud: true, source: "chargeback" },
        { transaction_id: "tx-1", is_fraud: "yes", source: "chargeback" },
        { transaction_id: "tx-2", is_fraud: true, source: "made_up" },
      ],
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/labels\[0\]/);
    expect(errors[1]).toMatch(/is_fraud/);
    expect(errors[2]).toMatch(/source/);
  });

  it("collapses duplicate transaction_ids last-wins", () => {
    const { labels, errors } = validateLabelBatch({
      labels: [label("tx-1", true), label("tx-1", false, GroundTruthSource.DISPUTE)],
    });
    expect(errors).toEqual([]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ is_fraud: false, source: "dispute" });
  });
});

describe("LabelService.ingest", () => {
  function makeService(applied: string[][]) {
    const calls: Array<{ labels: unknown[]; recordedBy: string }> = [];
    const repo = {
      applyLabels: jest.fn(async (labels: unknown[], recordedBy: string) => {
        calls.push({ labels, recordedBy });
        return applied.shift() ?? [];
      }),
    } as unknown as LabelRepo;
    return { service: new LabelService(repo), calls };
  }

  it("throws InvalidLabelBatchError on validation failure", async () => {
    const { service } = makeService([]);
    await expect(service.ingest({ labels: [{}] }, "ops")).rejects.toBeInstanceOf(
      InvalidLabelBatchError,
    );
  });

  it("returns applied/unmatched split", async () => {
    const { service, calls } = makeService([["tx-1"]]);
    const result = await service.ingest(
      { labels: [label("tx-1"), label("tx-2")] },
      "ops@fraudit",
    );

    expect(result).toEqual({ received: 2, applied: 1, unmatched: ["tx-2"] });
    expect(calls[0]?.recordedBy).toBe("ops@fraudit");
  });

  it("chunks large batches into multiple repo calls", async () => {
    const labels = Array.from({ length: 750 }, (_, i) => label(`tx-${i}`));
    const { service, calls } = makeService([
      labels.slice(0, 500).map((l) => l.transaction_id),
      labels.slice(500).map((l) => l.transaction_id),
    ]);

    const result = await service.ingest({ labels }, "ops");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.labels).toHaveLength(500);
    expect(calls[1]?.labels).toHaveLength(250);
    expect(result.applied).toBe(750);
    expect(result.unmatched).toEqual([]);
  });
});
