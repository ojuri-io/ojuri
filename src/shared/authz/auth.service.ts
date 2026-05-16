import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { singleton } from "tsyringe";
import UserRepo from "./repositories/user.repo";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { ALL_PERMISSIONS } from "./permissions";
import { evaluatePassword } from "./password-policy";

const log = createServiceLogger("AuthService");

const DEFAULT_TTL_SECONDS = 60 * 60 * 8; // 8h sessions

export interface AuthSubject {
  userId: string;
  tenantId: string;
  username: string;
  permissions: string[];
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    username: string;
    fullName: string | null;
    tenantId: string;
    roles: { id: string; name: string }[];
    permissions: string[];
    /**
     * Set on first login for the seeded admin and any user created
     * with a temp password. Frontend renders a blocking
     * password-change screen until cleared; server middleware refuses
     * every non-auth admin route while this is true so the gate
     * cannot be bypassed by direct API access.
     */
    mustChangePassword: boolean;
  };
}

export class PasswordRotationRequiredError extends Error {
  constructor(message = "Password rotation required") {
    super(message);
    this.name = "PasswordRotationRequiredError";
  }
}

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

@singleton()
class AuthService {
  constructor(private readonly users: UserRepo) {}

  async login(input: { tenantId?: string; username: string; password: string }): Promise<LoginResult> {
    const tenantId = input.tenantId ?? "default";
    const user = await this.users.findByUsername(tenantId, input.username);
    if (!user || !user.isActive) {
      log.info("login", "Login rejected: unknown or inactive user", {
        tenantId,
        username: input.username,
      });
      throw new InvalidCredentialsError();
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      log.info("login", "Login rejected: bad password", { id: user.id });
      throw new InvalidCredentialsError();
    }

    const detail = await this.users.findByIdWithRoles(user.id);
    if (!detail) {
      // Race: row deleted between findByUsername and findByIdWithRoles.
      throw new InvalidCredentialsError();
    }

    const permissions = mergePermissions(detail.roles);

    const ttl = parseInt(process.env.AUTH_JWT_TTL_SECONDS ?? "", 10);
    const expiresIn = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
    const secret = getJwtSecret();

    const subject: AuthSubject = {
      userId: detail.id,
      tenantId: detail.tenantId,
      username: detail.username,
      permissions,
    };
    const token = jwt.sign(subject, secret, { expiresIn });

    // Best-effort: never fail login because of a metadata write.
    this.users
      .touchLastLogin(detail.id)
      .catch((err) => log.warn("login", "touchLastLogin failed", { err: String(err) }));

    return {
      token,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      user: {
        id: detail.id,
        username: detail.username,
        fullName: detail.fullName,
        tenantId: detail.tenantId,
        roles: detail.roles.map((r) => ({ id: r.id, name: r.name })),
        permissions,
        mustChangePassword: !!user.mustChangePassword,
      },
    };
  }

  /**
   * Rotate the caller's own password. Verifies the current secret,
   * enforces a minimum complexity, persists the new bcrypt hash, and
   * clears `mustChangePassword`. The existing JWT remains valid — its
   * claims don't carry the flag — and the frontend re-fetches `/me`
   * after this call to refresh its local state.
   */
  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new InvalidCredentialsError();

    // Evaluate strength *before* verifying the current password — a
    // weak proposal is rejected regardless of whether the caller knew
    // the old secret, and the deny-list / username check needs the
    // user row anyway.
    const policy = evaluatePassword(input.newPassword, {
      username: user.username,
      currentPassword: input.currentPassword,
    });
    if (!policy.ok) {
      throw new WeakPasswordError(
        policy.issues[0] || "Password does not meet the strength policy"
      );
    }

    const ok = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!ok) throw new InvalidCredentialsError();

    const passwordHash = await bcrypt.hash(input.newPassword, 10);
    await this.users.updateById(input.userId, {
      passwordHash,
      mustChangePassword: false,
    });
    log.info("changePassword", "Password rotated", { userId: input.userId });
  }

  /**
   * Verify a presented bearer token. Returns the AuthSubject on success,
   * null otherwise. Pure JWT validation — no DB hit on the hot path.
   * Permission changes only take effect on the user's next login (8 h
   * default); short-cut by setting AUTH_JWT_TTL_SECONDS lower if that
   * latency is unacceptable for your deployment.
   */
  verifyToken(token: string): AuthSubject | null {
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
      if (
        typeof decoded.userId !== "string" ||
        typeof decoded.username !== "string" ||
        typeof decoded.tenantId !== "string" ||
        !Array.isArray(decoded.permissions)
      ) {
        return null;
      }
      return {
        userId: decoded.userId,
        username: decoded.username,
        tenantId: decoded.tenantId,
        permissions: decoded.permissions as string[],
      };
    } catch {
      return null;
    }
  }

  static hasPermission(subject: AuthSubject, required: string[]): boolean {
    if (subject.permissions.includes(ALL_PERMISSIONS)) return true;
    if (required.length === 0) return true;
    return required.some((p) => subject.permissions.includes(p));
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid username or password");
    this.name = "InvalidCredentialsError";
  }
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

function getJwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new AuthConfigError(
      "AUTH_JWT_SECRET must be set to a non-empty string of at least 16 characters"
    );
  }
  return secret;
}

function mergePermissions(roles: { permissions: string[] }[]): string[] {
  const set = new Set<string>();
  for (const r of roles) {
    for (const p of r.permissions) set.add(p);
  }
  return Array.from(set);
}

export default AuthService;
