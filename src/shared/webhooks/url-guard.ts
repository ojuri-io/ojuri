import { promises as dns } from "dns";
import { isIP } from "net";

export interface UrlVerdict {
  ok: boolean;
  reason?: string;
  /** The resolved IPv4/IPv6 address (when validation passed). Callers may
   * pin the connection to this address to defeat DNS-rebinding. */
  resolvedAddress?: string;
}

const ALLOW_HTTP =
  (process.env.WEBHOOK_ALLOW_HTTP ?? "false").toLowerCase() === "true";
const ALLOW_PRIVATE_NETWORKS =
  (process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS ?? "false").toLowerCase() === "true";

/**
 * Validate a webhook target URL against SSRF risks.
 *
 * Rejects:
 * - Non-`https` schemes (HTTP is allowed only when WEBHOOK_ALLOW_HTTP=true,
 *   intended for in-cluster testing — never in production).
 * - URLs whose hostname resolves to a loopback / private / link-local /
 *   multicast / reserved IP (cloud metadata endpoints, internal services,
 *   the host itself). Set WEBHOOK_ALLOW_PRIVATE_NETWORKS=true to bypass
 *   for sandboxed deployments where the operator owns every reachable IP.
 * - URLs with credentials embedded (user:pass@).
 *
 * Note that DNS-rebinding is still possible if the hostname resolves
 * differently between this check and the eventual fetch. Callers that
 * care should pin the resolved address from this function's result and
 * pass it through to the connection (or repeat the check pre-flight).
 */
export async function isWebhookUrlSafe(rawUrl: string): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url is not a valid absolute URL" };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "credentials in URL are not allowed" };
  }

  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:" && ALLOW_HTTP) {
    // explicit dev opt-in
  } else {
    return { ok: false, reason: `unsupported scheme ${url.protocol} (https required)` };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { ok: false, reason: "hostname is empty" };
  }

  // Resolve hostname → IP. Caller can override the verdict via the
  // env flag for sandboxed deployments where every reachable IP is owned.
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      addresses = records.map((r) => r.address);
    } catch (err) {
      return { ok: false, reason: `dns lookup failed: ${(err as Error).message}` };
    }
  }

  for (const addr of addresses) {
    if (!ALLOW_PRIVATE_NETWORKS && isPrivateAddress(addr)) {
      return {
        ok: false,
        reason: `${hostname} resolves to a private/loopback/link-local address (${addr})`,
      };
    }
  }

  return { ok: true, resolvedAddress: addresses[0] };
}

/** Block the addresses that drive cloud-credential exfil and lateral SSRF. */
function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isPrivateIPv4(addr);
  if (v === 6) return isPrivateIPv6(addr);
  return true; // unknown — be safe
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  // RFC1918, loopback, link-local, broadcast, multicast, reserved
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // 169.254/16 — includes IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 reserved
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped: ::ffff:a.b.c.d — apply v4 rules to the embedded address.
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}
