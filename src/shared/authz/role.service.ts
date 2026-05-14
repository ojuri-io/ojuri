import { singleton } from "tsyringe";
import RoleRepo from "./repositories/role.repo";
import { Role } from "./model/role.model";
import { PERMISSION_CODES, ALL_PERMISSIONS } from "./permissions";
import { ConflictError, NotFoundError } from "./user.service";
import { createServiceLogger } from "@shared/utils/logger/service-logger";

const log = createServiceLogger("RoleService");

@singleton()
class RoleService {
  constructor(private readonly roles: RoleRepo) {}

  list(tenantId?: string): Promise<Role[]> {
    return this.roles.list(tenantId);
  }

  async create(input: {
    tenantId?: string;
    name: string;
    description?: string;
    permissions: string[];
  }): Promise<Role> {
    const tenantId = input.tenantId ?? "default";
    const existing = await this.roles.findByName(tenantId, input.name);
    if (existing) {
      throw new ConflictError("A role with this name already exists in this tenant");
    }
    const permissions = validatePermissions(input.permissions, { allowWildcard: false });
    if (permissions.length === 0) {
      throw new ConflictError("A role must grant at least one permission");
    }
    const role = await this.roles.create({
      tenantId,
      name: input.name,
      description: input.description,
      permissions,
      isSystem: false,
    });
    log.info("create", "Custom role created", { id: role.id, name: role.name });
    return role;
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null; permissions?: string[] }
  ): Promise<Role> {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundError("Role not found");

    // SUPER_ADMIN is permanently pinned to ["*"] — refuse permission edits.
    if (role.isSystem && role.name === "SUPER_ADMIN" && patch.permissions) {
      throw new ConflictError("SUPER_ADMIN permissions are fixed at ['*'] and cannot be edited");
    }

    const update: Parameters<RoleRepo["updateById"]>[1] = {};
    if (patch.name !== undefined && patch.name !== role.name) {
      if (role.isSystem) {
        throw new ConflictError("System roles cannot be renamed");
      }
      const dup = await this.roles.findByName(role.tenantId, patch.name);
      if (dup) throw new ConflictError("A role with this name already exists in this tenant");
      update.name = patch.name;
    }
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.permissions !== undefined) {
      const permissions = validatePermissions(patch.permissions, { allowWildcard: false });
      if (permissions.length === 0) {
        throw new ConflictError("A role must grant at least one permission");
      }
      update.permissions = permissions;
    }

    if (Object.keys(update).length === 0) return role;

    const next = await this.roles.updateById(id, update);
    if (!next) throw new NotFoundError("Role not found after update");
    log.info("update", "Role updated", { id, fields: Object.keys(update) });
    return next;
  }

  async delete(id: string): Promise<void> {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundError("Role not found");
    if (role.isSystem) {
      throw new ConflictError("System roles cannot be deleted");
    }
    await this.roles.deleteById(id);
    log.info("delete", "Role deleted", { id });
  }
}

/**
 * Reject codes not in the catalogue. Optionally reject the `*` wildcard
 * (it's only allowed on the seeded SUPER_ADMIN role, never on
 * user-created roles).
 */
export function validatePermissions(
  codes: string[],
  opts: { allowWildcard: boolean }
): string[] {
  const seen = new Set<string>();
  for (const code of codes) {
    if (typeof code !== "string" || code.length === 0) {
      throw new ConflictError("Permission codes must be non-empty strings");
    }
    if (code === ALL_PERMISSIONS) {
      if (!opts.allowWildcard) {
        throw new ConflictError("Wildcard '*' is reserved for the SUPER_ADMIN system role");
      }
    } else if (!PERMISSION_CODES.has(code)) {
      throw new ConflictError(`Unknown permission: ${code}`);
    }
    seen.add(code);
  }
  return Array.from(seen);
}

export default RoleService;
