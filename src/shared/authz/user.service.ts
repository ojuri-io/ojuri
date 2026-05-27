import bcrypt from "bcrypt";
import { singleton } from "tsyringe";
import UserRepo, { UserWithRoles } from "./repositories/user.repo";
import RoleRepo from "./repositories/role.repo";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { BCRYPT_ROUNDS } from "./auth.service";

const log = createServiceLogger("UserService");

@singleton()
class UserService {
  constructor(
    private readonly users: UserRepo,
    private readonly roles: RoleRepo
  ) {}

  async list(opts: {
    tenantId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ rows: UserWithRoles[]; total: number }> {
    return this.users.listWithRoles(opts);
  }

  async get(id: string): Promise<UserWithRoles | null> {
    return this.users.findByIdWithRoles(id);
  }

  async create(input: {
    tenantId?: string;
    username: string;
    password: string;
    fullName?: string;
    email?: string;
    roleIds?: string[];
    createdBy?: string;
  }): Promise<UserWithRoles> {
    const tenantId = input.tenantId ?? "default";
    const existing = await this.users.findByUsername(tenantId, input.username);
    if (existing) {
      throw new ConflictError("A user with this username already exists in this tenant");
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.users.create({
      tenantId,
      username: input.username,
      passwordHash,
      fullName: input.fullName,
      email: input.email,
    });

    if (input.roleIds && input.roleIds.length > 0) {
      for (const roleId of input.roleIds) {
        const role = await this.roles.findById(roleId);
        if (!role) throw new NotFoundError(`Role not found: ${roleId}`);
        await this.users.assignRole(user.id, roleId, input.createdBy);
      }
    }

    const detail = await this.users.findByIdWithRoles(user.id);
    if (!detail) throw new Error("User created but could not be re-read");
    log.info("create", "User created", { id: user.id, tenantId });
    return detail;
  }

  async update(
    id: string,
    input: {
      password?: string;
      fullName?: string | null;
      email?: string | null;
      isActive?: boolean;
      disabledReason?: string | null;
    }
  ): Promise<UserWithRoles> {
    const existing = await this.users.findByIdWithRoles(id);
    if (!existing) throw new NotFoundError("User not found");

    const patch: Parameters<UserRepo["updateById"]>[1] = {};
    if (input.password) {
      patch.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    }
    if (input.fullName !== undefined) patch.fullName = input.fullName;
    if (input.email !== undefined) patch.email = input.email;
    if (input.isActive !== undefined) {
      patch.isActive = input.isActive;
      if (!input.isActive) {
        patch.disabledReason = input.disabledReason ?? null;
      } else {
        patch.disabledReason = null;
      }
    }

    if (Object.keys(patch).length === 0) {
      return existing;
    }

    await this.users.updateById(id, patch);
    const detail = await this.users.findByIdWithRoles(id);
    if (!detail) throw new NotFoundError("User not found after update");
    log.info("update", "User updated", { id, fields: Object.keys(patch) });
    return detail;
  }

  async delete(id: string, actingUserId?: string): Promise<void> {
    if (actingUserId && actingUserId === id) {
      throw new ConflictError("You cannot delete your own account");
    }
    const existing = await this.users.findByIdWithRoles(id);
    if (!existing) throw new NotFoundError("User not found");
    await this.users.deleteById(id);
    log.info("delete", "User deleted", { id });
  }

  async assignRole(userId: string, roleId: string, assignedBy?: string): Promise<UserWithRoles> {
    const user = await this.users.findByIdWithRoles(userId);
    if (!user) throw new NotFoundError("User not found");
    const role = await this.roles.findById(roleId);
    if (!role) throw new NotFoundError("Role not found");

    await this.users.assignRole(userId, roleId, assignedBy);
    const detail = await this.users.findByIdWithRoles(userId);
    if (!detail) throw new NotFoundError("User not found after role assignment");
    return detail;
  }

  async unassignRole(userId: string, roleId: string): Promise<UserWithRoles> {
    const user = await this.users.findByIdWithRoles(userId);
    if (!user) throw new NotFoundError("User not found");
    // Guard: a user must keep at least one role.
    if (user.roles.length === 1 && user.roles[0]?.id === roleId) {
      throw new ConflictError("Cannot remove the user's last remaining role");
    }
    await this.users.unassignRole(userId, roleId);
    const detail = await this.users.findByIdWithRoles(userId);
    if (!detail) throw new NotFoundError("User not found after role removal");
    return detail;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export default UserService;
