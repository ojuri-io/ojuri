import { injectable } from "tsyringe";
import { User } from "../model/user.model";
import { Role } from "../model/role.model";
import { UserRole } from "../model/user-role.model";

export interface UserWithRoles {
  id: string;
  username: string;
  fullName: string | null;
  email: string | null;
  tenantId: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { id: string; name: string; permissions: string[] }[];
}

@injectable()
class UserRepo {
  async findByUsername(tenantId: string, username: string): Promise<User | undefined> {
    return User.query().where({ tenantId, username }).first();
  }

  async findById(id: string): Promise<User | undefined> {
    return User.query().findById(id);
  }

  async findByIdWithRoles(id: string): Promise<UserWithRoles | null> {
    const user = await User.query().findById(id);
    if (!user) return null;

    const rows = await UserRole.query()
      .where({ userId: id })
      .joinRelated("role" as never)
      .select(
        "userRoles.roleId as id",
        "role.name as name",
        "role.permissions as permissions"
      );

    return mapWithRoles(user, rows as unknown as RawRoleRow[]);
  }

  async listWithRoles(opts: {
    tenantId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ rows: UserWithRoles[]; total: number }> {
    const baseQuery = User.query();
    if (opts.tenantId) baseQuery.where({ tenantId: opts.tenantId });
    if (opts.search && opts.search.trim()) {
      const s = `%${opts.search.trim()}%`;
      baseQuery.where((b) => {
        b.where("username", "ilike", s)
          .orWhere("fullName", "ilike", s)
          .orWhere("email", "ilike", s);
      });
    }

    const total = (await baseQuery.clone().resultSize()) as unknown as number;

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);

    const users = await baseQuery
      .clone()
      .orderBy("createdAt", "desc")
      .limit(limit)
      .offset(offset);

    if (users.length === 0) return { rows: [], total: Number(total) || 0 };

    const userIds = users.map((u) => u.id);
    const roleRows = (await UserRole.query()
      .whereIn("userId", userIds)
      .joinRelated("role" as never)
      .select(
        "userRoles.userId as userId",
        "userRoles.roleId as id",
        "role.name as name",
        "role.permissions as permissions"
      )) as unknown as RawRoleRowWithUser[];

    const byUser = new Map<string, RawRoleRow[]>();
    for (const r of roleRows) {
      const arr = byUser.get(r.userId) ?? [];
      arr.push({ id: r.id, name: r.name, permissions: r.permissions });
      byUser.set(r.userId, arr);
    }

    return {
      rows: users.map((u) => mapWithRoles(u, byUser.get(u.id) ?? [])),
      total: Number(total) || 0,
    };
  }

  async create(input: {
    tenantId: string;
    username: string;
    passwordHash: string;
    fullName?: string;
    email?: string;
    mustChangePassword?: boolean;
  }): Promise<User> {
    return User.query().insert(input).returning("*");
  }

  async updateById(
    id: string,
    patch: Partial<{
      passwordHash: string;
      fullName: string | null;
      email: string | null;
      isActive: boolean;
      disabledReason: string | null;
      lastLoginAt: Date;
      mustChangePassword: boolean;
    }>
  ): Promise<User | undefined> {
    return User.query().patchAndFetchById(id, patch);
  }

  async deleteById(id: string): Promise<number> {
    return User.query().deleteById(id);
  }

  async touchLastLogin(id: string): Promise<void> {
    await User.query().where({ id }).patch({ lastLoginAt: new Date() });
  }

  async assignRole(userId: string, roleId: string, assignedBy?: string): Promise<void> {
    // Defensive: ignore the duplicate-key error so re-assignment is a no-op.
    try {
      await UserRole.query().insert({ userId, roleId, assignedBy: assignedBy ?? null });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  async unassignRole(userId: string, roleId: string): Promise<number> {
    return UserRole.query().delete().where({ userId, roleId });
  }
}

interface RawRoleRow {
  id: string;
  name: string;
  permissions: string[];
}

interface RawRoleRowWithUser extends RawRoleRow {
  userId: string;
}

function mapWithRoles(u: User, roles: RawRoleRow[]): UserWithRoles {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    tenantId: u.tenantId,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roles,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

// Objection relation mapping wired here so the repo + model files don't have
// circular import noise. Static so Objection picks it up before first query.
(User as unknown as { relationMappings: unknown }).relationMappings = {
  roles: {
    relation: Role.ManyToManyRelation,
    modelClass: Role,
    join: {
      from: `${User.tableName}.id`,
      through: {
        from: `${UserRole.tableName}.userId`,
        to: `${UserRole.tableName}.roleId`,
      },
      to: `${Role.tableName}.id`,
    },
  },
};
(UserRole as unknown as { relationMappings: unknown }).relationMappings = {
  role: {
    relation: UserRole.BelongsToOneRelation,
    modelClass: Role,
    join: {
      from: `${UserRole.tableName}.roleId`,
      to: `${Role.tableName}.id`,
    },
  },
  user: {
    relation: UserRole.BelongsToOneRelation,
    modelClass: User,
    join: {
      from: `${UserRole.tableName}.userId`,
      to: `${User.tableName}.id`,
    },
  },
};

export default UserRepo;
