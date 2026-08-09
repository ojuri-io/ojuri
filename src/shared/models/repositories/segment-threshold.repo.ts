import { injectable } from "tsyringe";
import { BaseRepository } from "../../repositories/base.repo";
import { ISegmentThreshold, SegmentThreshold } from "../model/segment-threshold.model";

@injectable()
class SegmentThresholdRepo extends BaseRepository<ISegmentThreshold, SegmentThreshold> {
  constructor() {
    super(SegmentThreshold);
  }

  async listActive(): Promise<SegmentThreshold[]> {
    return SegmentThreshold.query().where({ isActive: true });
  }

  /**
   * All segment-threshold rows, newest first. Used by the admin UI so
   * operators can see overrides even after they've been deactivated.
   */
  async listAll(): Promise<SegmentThreshold[]> {
    return SegmentThreshold.query().orderBy("updatedAt", "desc");
  }

  /**
   * Clone every active override from one model version onto another.
   * Existing rows on the target win — an operator who already tuned the
   * incoming version must not have it overwritten by the outgoing one.
   */
  async carryForward(fromVersion: string, toVersion: string): Promise<number> {
    const source = await SegmentThreshold.query().where({
      modelVersion: fromVersion,
      isActive: true,
    });
    if (source.length === 0) return 0;

    const rows = source.map((r) => ({
      segment: r.segment,
      modelVersion: toVersion,
      threshold: r.threshold,
      isActive: true,
    }));

    const result = await SegmentThreshold.knex()(SegmentThreshold.tableName)
      .insert(rows)
      .onConflict(["segment", "modelVersion"])
      .ignore();

    // ON CONFLICT DO NOTHING skips existing rows, so the driver's
    // rowCount is the only honest answer to "how many were copied".
    if (Array.isArray(result)) return result.length;
    return (result as { rowCount?: number })?.rowCount ?? 0;
  }

  async upsert(input: { segment: string; modelVersion: string; threshold: number }): Promise<void> {
    // Objection has no first-class upsert. Use raw `ON CONFLICT` via
    // the underlying knex builder for the (segment, modelVersion)
    // unique constraint.
    await SegmentThreshold.knex()(SegmentThreshold.tableName)
      .insert({
        segment: input.segment,
        modelVersion: input.modelVersion,
        threshold: input.threshold,
        isActive: true,
      })
      .onConflict(["segment", "modelVersion"])
      .merge({
        threshold: input.threshold,
        isActive: true,
        updatedAt: SegmentThreshold.knex().fn.now(),
      });
  }
}

export default SegmentThresholdRepo;
