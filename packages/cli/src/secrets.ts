import { randomBytes } from "node:crypto";

/**
 * Secrets `ojuri init` writes into a fresh `.env`.
 *
 * Everything is base64url rather than plain base64, so no value can
 * contain `+`, `/` or `=`. Those need percent-encoding inside the
 * DB_URL connection string, and a password that has to be escaped in
 * one place and not another is a bug waiting to be filed.
 */

/** Matches `openssl rand -base64 48` in strength; RDA wants 32 chars or more. */
export function generateJwtSecret(): string {
  return randomBytes(48).toString("base64url");
}

/** Goes into POSTGRES_PASSWORD, DB_PASSWORD and the DB_URL together. */
export function generatePostgresPassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The seeded admin's bootstrap password. 18 bytes of base64url is 24
 * characters, matching what the migration generates for itself, and
 * comfortably over the 12-character floor it enforces.
 */
export function generateAdminPassword(): string {
  return randomBytes(18).toString("base64url");
}

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
