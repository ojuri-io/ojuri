import { injectable } from "tsyringe";
import { transaction } from "objection";
import { BaseRepository } from "../../repositories/base.repo";
import { IModelVersion, ModelVersion } from "../model/model-version.model";

@injectable()
class ModelVersionRepo extends BaseRepository<IModelVersion, ModelVersion> {
  constructor() {
    super(ModelVersion);
  }

  async deleteByVersion(version: string): Promise<number> {
    return ModelVersion.query().delete().where({ version });
  }

  async findByVersion(version: string): Promise<ModelVersion | undefined> {
    return ModelVersion.query().findOne({ version });
  }

  async listOrdered(): Promise<ModelVersion[]> {
    return ModelVersion.query().orderBy("createdAt", "desc");
  }

  async listAll(): Promise<ModelVersion[]> {
    return ModelVersion.query();
  }

  async update(
    version: string,
    patch: Partial<Pick<IModelVersion, "defaultThreshold" | "metrics" | "metadata">>
  ): Promise<ModelVersion | undefined> {
    const fields: Partial<IModelVersion> = {};
    if (typeof patch.defaultThreshold === "number") fields.defaultThreshold = patch.defaultThreshold;
    if (patch.metrics !== undefined) fields.metrics = patch.metrics;
    if (patch.metadata !== undefined) fields.metadata = patch.metadata;
    if (Object.keys(fields).length === 0) return this.findByVersion(version);

    await ModelVersion.query().where({ version }).patch(fields);
    return this.findByVersion(version);
  }

  /**
   * Apply a status transition atomically. ACTIVE retires the prior
   * champion; SHADOW demotes the prior shadow back to CANDIDATE.
   * Returns the updated row.
   */
  async transitionStatus(version: string, status: string): Promise<ModelVersion | undefined> {
    await transaction(ModelVersion.knex(), async (trx) => {
      if (status === "ACTIVE") {
        await ModelVersion.query(trx)
          .where({ status: "ACTIVE" })
          .whereNot({ version })
          .patch({ status: "RETIRED", retiredAt: new Date() });
      }
      if (status === "SHADOW") {
        await ModelVersion.query(trx)
          .where({ status: "SHADOW" })
          .whereNot({ version })
          .patch({ status: "CANDIDATE" });
      }

      const patch: Partial<IModelVersion> = { status };
      if (status === "ACTIVE") patch.activatedAt = new Date();
      if (status === "RETIRED") patch.retiredAt = new Date();

      await ModelVersion.query(trx).where({ version }).patch(patch);
    });

    return this.findByVersion(version);
  }
}

export default ModelVersionRepo;
