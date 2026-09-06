/**
 * The CORS allowlist, derived from `network.public_url`.
 *
 * This is the one place that decides the value. `ojuri validate` checks
 * it against RDA's production guard and `ojuri render` writes it into
 * SENTINEL_CORS_ORIGINS, so the two cannot disagree about what the
 * stack will be told. `test/render.spec.ts` pins that.
 *
 * A local public URL means someone is developing, and development means
 * the Vite dev server on :5173 and a direct RDA on :3000 both need to
 * reach the API from another origin. Those are exactly the two entries
 * `.env.example` ships, which is also what keeps rendering the default
 * manifest a no-op. A real public origin needs neither: the dashboard
 * is served from the same origin as the API it calls.
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
