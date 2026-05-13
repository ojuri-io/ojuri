import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
import { IdempotencyKey, IIdempotencyKey } from "../model/idempotency-key.model";

@injectable()
class IdempotencyKeyRepo extends BaseRepository<IIdempotencyKey, IdempotencyKey> {
  constructor() {
    super(IdempotencyKey);
  }

  async findByCompositeKey(tenantId: string, key: string): Promise<IdempotencyKey | undefined> {
    return IdempotencyKey.query().findOne({ tenantId, key });
  }

  async insertIgnoringConflict(input: {
    tenantId: string;
    key: string;
    requestHash: string;
    response: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<void> {
    await IdempotencyKey.knex()(IdempotencyKey.tableName)
      .insert(input)
      .onConflict(["tenantId", "key"])
      .ignore();
  }
}

export default IdempotencyKeyRepo;
