import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
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
