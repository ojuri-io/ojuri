import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { singleton } from "tsyringe";
import UserRepo from "./repositories/user.repo";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { ALL_PERMISSIONS } from "./permissions";
import { evaluatePassword } from "./password-policy";
import { DEMO_USERNAME } from "./demo-account";
import {
  GrantsCacheEntry,
  LiveGrants,
  SignInOptions,
  SignInOptionsCacheEntry,
} from "./auth.types";

const log = createServiceLogger("AuthService");

const DEFAULT_TTL_SECONDS = 60 * 60 * 8;
const BCRYPT_ROUNDS = 12;
const GRANTS_CACHE_TTL_MS = 30_000;
const GRANTS_CACHE_CAP = 10_000;
const SIGN_IN_OPTIONS_CACHE_TTL_MS = 60_000;

// Rendered as a link on the sign-in page, so anything but http(s) is dropped:
// the value is operator-set, but an unauthenticated endpoint should not be able
// to hand a browser a `javascript:` href under any configuration.
function demoCredentialsUrl(): string | null {
  const raw = (process.env.DEMO_CREDENTIALS_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Constant-time login: compare against this hash on the unknown-user
// branch so response latency doesn't leak whether the username exists.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  "ojuri-constant-time-dummy-do-not-use",
  BCRYPT_ROUNDS
);

export interface AuthSubject {
  userId: string;
  tenantId: string;
  username: string;
  permissions: string[];
  mustChangePassword: boolean;
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
  private grantsCache = new Map<string, GrantsCacheEntry>();
  private signInOptionsCache: SignInOptionsCacheEntry | null = null;

  constructor(private readonly users: UserRepo) {}

  /**
   * What an unauthenticated visitor needs to know before they can sign in.
   *
   * Answered from the database rather than from `SEED_DEMO_USER`, because the
   * env var records an intent and the row records a fact — a migration run
   * before the var was set exits 0 having created nothing, and an env-based
   * answer would then point visitors at an account that does not exist.
   *
   * This is the one place that confirms a username exists to an anonymous
   * caller. It is scoped to the single account whose credentials are published
   * on purpose; every other user stays behind the constant-time login path.
   */
  async signInOptions(): Promise<SignInOptions> {
    const now = Date.now();
    if (this.signInOptionsCache && this.signInOptionsCache.expiresAt > now) {
      return this.signInOptionsCache.options;
    }

    const demo = await this.users.findByUsername("default", DEMO_USERNAME);
    const options: SignInOptions = {
      demoAccount:
        demo && demo.isActive
          ? { username: DEMO_USERNAME, credentialsUrl: demoCredentialsUrl() }
          : null,
    };

    this.signInOptionsCache = { options, expiresAt: now + SIGN_IN_OPTIONS_CACHE_TTL_MS };
    return options;
  }

  async login(input: { tenantId?: string; username: string; password: string }): Promise<LoginResult> {
    const tenantId = input.tenantId ?? "default";
    const user = await this.users.findByUsername(tenantId, input.username);

    const hashToCheck = user?.passwordHash ?? DUMMY_BCRYPT_HASH;
    const passwordOk = await bcrypt.compare(input.password, hashToCheck);

    if (!user || !user.isActive) {
      log.info("login", "Login rejected: unknown or inactive user", {
        tenantId,
        username: input.username,
      });
      throw new InvalidCredentialsError();
    }
    if (!passwordOk) {
      log.info("login", "Login rejected: bad password", { id: user.id });
      throw new InvalidCredentialsError();
    }

    const detail = await this.users.findByIdWithRoles(user.id);
    if (!detail) throw new InvalidCredentialsError(); // user deleted between calls

    const permissions = mergePermissions(detail.roles);
    const mustChangePassword = !!user.mustChangePassword;
    this.invalidateGrants(detail.id);

    const { token, expiresIn } = this.mintToken({
      userId: detail.id,
      tenantId: detail.tenantId,
      username: detail.username,
      permissions,
      mustChangePassword,
    });

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
        mustChangePassword,
      },
    };
  }

  private mintToken(subject: AuthSubject): { token: string; expiresIn: number } {
    const ttl = parseInt(process.env.AUTH_JWT_TTL_SECONDS ?? "", 10);
    const expiresIn = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
    const token = jwt.sign(subject, getJwtSecret(), {
      algorithm: "HS256",
      expiresIn,
      ...(process.env.AUTH_JWT_ISSUER ? { issuer: process.env.AUTH_JWT_ISSUER } : {}),
      ...(process.env.AUTH_JWT_AUDIENCE ? { audience: process.env.AUTH_JWT_AUDIENCE } : {}),
    });
    return { token, expiresIn };
  }

  /**
   * Rotate the caller's own password and mint a fresh JWT. The caller
   * must replace its stored token with the returned one — the previous
   * token's mustChangePassword=true claim would otherwise keep tripping
   * the rotation gate for the remainder of its TTL.
   */
  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ token: string; expiresAt: string }> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new InvalidCredentialsError();

    // Verify before evaluating the new-password policy — otherwise an
    // attacker who guessed the username could probe the complexity
    // rules without knowing the current secret.
    const ok = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!ok) throw new InvalidCredentialsError();

    const policy = evaluatePassword(input.newPassword, {
      username: user.username,
      currentPassword: input.currentPassword,
    });
    if (!policy.ok) {
      throw new WeakPasswordError(
        policy.issues[0] || "Password does not meet the strength policy"
      );
    }

    const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
    await this.users.updateById(input.userId, { passwordHash, mustChangePassword: false });
    this.invalidateGrants(input.userId);
    log.info("changePassword", "Password rotated", { userId: input.userId });

    const detail = await this.users.findByIdWithRoles(input.userId);
    if (!detail) throw new InvalidCredentialsError();
    const minted = this.mintToken({
      userId: detail.id,
      tenantId: detail.tenantId,
      username: detail.username,
      permissions: mergePermissions(detail.roles),
      mustChangePassword: false,
    });
    return {
      token: minted.token,
      expiresAt: new Date(Date.now() + minted.expiresIn * 1000).toISOString(),
    };
  }

  /**
   * Constant-time check of a bearer token against the configured
   * `MLA_SERVICE_TOKEN` shared secret. When it matches, synthesise a
   * non-user subject scoped to the two model-lifecycle permissions MLA
   * actually needs — register a new version and flip its status.
   *
   * Why static-secret instead of JWT for this caller:
   *   - MLA is a long-running process; rotating a JWT mid-run would add
   *     a refresh thread for one of the lowest-rate callers in the system.
   *   - The token never leaves the trust boundary (same docker network or
   *     same operator-managed host).
   *
   * Length floor is 32 chars to make guessing infeasible without
   * adding extra rate-limit machinery on the admin routes. Token is
   * compared via SHA-256 digest + timingSafeEqual so neither value nor
   * length leak through response timing.
   */
  verifyServiceToken(token: string): AuthSubject | null {
    const expected = process.env.MLA_SERVICE_TOKEN;
    if (!expected || expected.length < 32) return null;
    const tokenDigest = crypto.createHash("sha256").update(token).digest();
    const expectedDigest = crypto.createHash("sha256").update(expected).digest();
    if (!crypto.timingSafeEqual(tokenDigest, expectedDigest)) return null;
    return {
      userId: "service:mla",
      tenantId: "default",
      username: "mla-service",
      permissions: ["models:read", "models:register", "models:set_status"],
      mustChangePassword: false,
    };
  }

  verifyToken(token: string): AuthSubject | null {
    try {
      const decoded = jwt.verify(token, getJwtSecret(), {
        algorithms: ["HS256"],
        ...(process.env.AUTH_JWT_ISSUER ? { issuer: process.env.AUTH_JWT_ISSUER } : {}),
        ...(process.env.AUTH_JWT_AUDIENCE ? { audience: process.env.AUTH_JWT_AUDIENCE } : {}),
      }) as jwt.JwtPayload;
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
        // Default false for tokens minted before this claim existed —
        // fail-open here is correct because the previous middleware was
        // the source of truth, not the token.
        mustChangePassword: typeof decoded.mustChangePassword === "boolean"
          ? decoded.mustChangePassword
          : false,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify a JWT and overlay the subject's grants (permissions,
   * mustChangePassword) with the current database state. The token's
   * permission claim is only a login-time snapshot — treating it as
   * authoritative meant role changes and user deactivation did not
   * apply until the next login (up to the 8 h token TTL).
   *
   * Returns null for a missing or deactivated user, so revocation
   * takes effect within the cache TTL instead of at token expiry.
   */
  async verifyTokenLive(token: string): Promise<AuthSubject | null> {
    const claims = this.verifyToken(token);
    if (!claims) return null;
    const grants = await this.loadLiveGrants(claims.userId);
    if (!grants) return null;
    return { ...claims, ...grants };
  }

  /** Drop cached grants for one user, or for everyone when a role's permission set changes. */
  invalidateGrants(userId?: string): void {
    if (userId) this.grantsCache.delete(userId);
    else this.grantsCache.clear();
  }

  private async loadLiveGrants(userId: string): Promise<LiveGrants | null> {
    const now = Date.now();
    const cached = this.grantsCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.grants;
    if (cached) this.grantsCache.delete(userId);

    const detail = await this.users.findByIdWithRoles(userId);
    const grants: LiveGrants | null =
      detail && detail.isActive
        ? {
            permissions: mergePermissions(detail.roles),
            mustChangePassword: detail.mustChangePassword,
          }
        : null;

    // Negative results are safe to cache: userIds only come from
    // signature-verified JWTs, so the cache cannot be sprayed full
    // of attacker-chosen keys the way raw API tokens could.
    if (this.grantsCache.size >= GRANTS_CACHE_CAP) {
      const oldest = this.grantsCache.keys().next().value;
      if (oldest) this.grantsCache.delete(oldest);
    }
    this.grantsCache.set(userId, { grants, expiresAt: now + GRANTS_CACHE_TTL_MS });
    return grants;
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

export { BCRYPT_ROUNDS };

function mergePermissions(roles: { permissions: string[] }[]): string[] {
  const set = new Set<string>();
  for (const r of roles) {
    for (const p of r.permissions) set.add(p);
  }
  return Array.from(set);
}

export default AuthService;
