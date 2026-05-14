import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
import { ISavedReport, SavedReport } from "../model/saved-report.model";

@injectable()
class SavedReportRepo extends BaseRepository<ISavedReport, SavedReport> {
  constructor() {
    super(SavedReport);
  }

  async listAll(tenantId?: string | null): Promise<SavedReport[]> {
    const q = SavedReport.query().orderBy("updatedAt", "desc");
    if (tenantId) q.where({ tenantId });
    return q;
  }

  async patchById(id: string, patch: Partial<ISavedReport>): Promise<SavedReport | undefined> {
    if (Object.keys(patch).length === 0) return SavedReport.query().findById(id);
    await SavedReport.query().where({ id }).patch(patch);
    return SavedReport.query().findById(id);
  }

  async deleteById(id: string): Promise<number> {
    return SavedReport.query().deleteById(id);
  }
}

export default SavedReportRepo;
