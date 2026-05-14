import { injectable } from "tsyringe";
import { Role } from "../model/role.model";

@injectable()
class RoleRepo {
  async findById(id: string): Promise<Role | undefined> {
    return Role.query().findById(id);
  }

  async findByName(tenantId: string, name: string): Promise<Role | undefined> {
    return Role.query().where({ tenantId, name }).first();
  }

  async list(tenantId?: string): Promise<Role[]> {
    const query = Role.query().orderBy([
      { column: "isSystem", order: "desc" },
      { column: "name", order: "asc" },
    ]);
    if (tenantId) query.where({ tenantId });
    return query;
  }

  async create(input: {
    tenantId: string;
    name: string;
    description?: string;
    permissions: string[];
    isSystem?: boolean;
  }): Promise<Role> {
    return Role.query()
      .insert({
        ...input,
        isSystem: input.isSystem ?? false,
      })
      .returning("*");
  }

  async updateById(
    id: string,
    patch: Partial<{ name: string; description: string | null; permissions: string[] }>
  ): Promise<Role | undefined> {
    return Role.query().patchAndFetchById(id, patch);
  }

  async deleteById(id: string): Promise<number> {
    return Role.query().deleteById(id);
  }
}

export default RoleRepo;
