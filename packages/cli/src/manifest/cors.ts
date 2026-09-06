/**
 * The CORS allowlist, derived from `network.public_url`.
 *
 * This is the one place that decides the value. `ojuri validate` checks
 * it against RDA's production guard and `ojuri render` writes it into
 * SENTINEL_CORS_ORIGINS, so the two cannot disagree about what the
 * stack will be told. `test/render.spec.ts` pins that.
 *
 * ---------------------------------------------------------------------
 * Why a local URL does not map to itself. Read this before simplifying.
 *
 * The obvious implementation is the identity function: whatever
 * `public_url` says, that is the allowlist. It is wrong twice over, and
 * both failures are quiet.
 *
 * 1. It breaks the Sentinel dev server. `public_url` describes where
 *    NGINX serves the stack, which on a developer's machine is
 *    http://localhost. But the dashboard in development runs on the Vite
 *    server at :5173, and a host-side RDA runs on :3000. Neither is the
 *    same origin as http://localhost, so with an identity mapping the
 *    browser would refuse every call the dev server makes. The two
 *    entries below are exactly what `.env.example` ships, for exactly
 *    this reason.
 *
 * 2. It breaks the no-op property. Rendering the committed `ojuri.yaml`
 *    has to produce a `.env.rendered` whose values match `.env.example`,
 *    which is what lets adopters ignore the manifest entirely and keep
 *    the README quick start. `.env.example` sets
 *    SENTINEL_CORS_ORIGINS to the two dev origins while `public_url`
 *    defaults to http://localhost, so an identity mapping renders a
 *    different value and the CI job that diffs `docker compose config`
 *    both ways fails.
 *
 * A real public origin needs neither entry: there, the dashboard is
 * served from the same origin as the API it calls, so the origin itself
 * is the whole allowlist.
 *
 * Note that validate's behaviour is unchanged either way. Both branches
 * are checked for the substring "localhost", so a local `public_url`
 * still trips RDA's production guard, which is the point of that rule.
 * ---------------------------------------------------------------------
 */
export const LOCAL_DEV_ORIGINS = "http://localhost:5173,http://localhost:3000";

export function derivedCorsOrigins(publicUrl: string): string {
  return isLocal(publicUrl) ? LOCAL_DEV_ORIGINS : publicUrl;
}

function isLocal(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
