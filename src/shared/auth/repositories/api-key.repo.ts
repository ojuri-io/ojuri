import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
import { ApiKey, IApiKey } from "../model/api-key.model";

@injectable()
class ApiKeyRepo extends BaseRepository<IApiKey, ApiKey> {
  constructor() {
    super(ApiKey);
  }

  async findByHash(keyHash: string): Promise<ApiKey | undefined> {
    return ApiKey.query().where({ keyHash, isActive: true }).first();
  }

  async touchLastUsed(id: string): Promise<void> {
    await ApiKey.query().where({ id }).patch({ lastUsedAt: new Date() });
  }

  async revoke(id: string, reason: string | null): Promise<number> {
    return ApiKey.query()
      .where({ id })
      .patch({ isActive: false, revokedAt: new Date(), revokedReason: reason });
  }

  async listAll(tenantId?: string): Promise<Partial<IApiKey>[]> {
    const query = ApiKey.query()
      .select(
        "id",
        "tenantId",
        "name",
        "keyPrefix",
        "scope",
        "rateLimitPerMinute",
        "isActive",
        "lastUsedAt",
        "expiresAt",
        "revokedAt",
        "createdAt"
      )
      .orderBy("createdAt", "desc");
    if (tenantId) query.where({ tenantId });
    return query;
  }
}

export default ApiKeyRepo;
