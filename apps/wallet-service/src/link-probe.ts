/**
 * The x402 step of "add any service by link" (docs/ARCHITECTURE.md §18): a plain GET of the link,
 * expecting 402 with an x402 v2 PAYMENT-REQUIRED that offers USDC on the configured network.
 *
 * Safety: no body, no credentials, 8 s timeout, redirects are followed by hand (at most 2) and every
 * hop is checked first. Private, loopback and link-local targets are refused unless their origin is
 * one of the configured local service origins (in mock mode the merchant runs on localhost).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { X402PaymentRequired, X402PaymentRequirements } from "@allowance/shared";

export interface X402Probe {
  /** The URL that answered 402 (after any redirects), query kept. */
  url: string;
  /** `url` without query or fragment, trailing slashes trimmed: the connection's prefix. */
  baseUrl: string;
  host: string;
  /** The resource description, else the host (≤ 60 chars). */
  name: string;
  /** The resource description, if the challenge had one (≤ 200 chars). */
  description?: string;
  /** The USDC offer that matched. `amount` is in base units. */
  requirements: X402PaymentRequirements;
}

export type ProbeResult = { ok: true; probe: X402Probe } | { ok: false; reason: string };

export interface ProbeOptions {
  network: string;
  asset: string;
  /** Origins allowed even though they are local (MERCHANT_URL, bridges, directory services). */
  allowOrigins: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Hostname → addresses. Defaults to DNS. */
  resolve?: (host: string) => Promise<string[]>;
  maxRedirects?: number;
}

const dnsResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** True for loopback, private, link-local, CGNAT, unspecified, multicast and reserved IPv4/IPv6 addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("::ffff:") || s.startsWith("64:ff9b:");
  }
  return true; // not an address at all: refuse
}

function normOrigin(o: string): string {
  try {
    return new URL(o).origin;
  } catch {
    return "";
  }
}

/** null when `url` may be probed, else why not. */
async function refuse(url: URL, allowed: ReadonlySet<string>, resolve: (host: string) => Promise<string[]>): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http(s) links can be probed";
  if (url.username || url.password) return "links with credentials are not probed";
  if (allowed.has(url.origin)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return `${url.host} is a private address`;
  if (isIP(host)) return isPrivateIp(host) ? `${url.host} is a private address` : null;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return `${url.host} did not resolve`;
  }
  if (!addrs.length) return `${url.host} did not resolve`;
  return addrs.some(isPrivateIp) ? `${url.host} resolves to a private address` : null;
}

function decodeChallenge(res: Response, bodyText: string): X402PaymentRequired | null {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (header) {
    try {
      return decodePaymentRequiredHeader(header) as unknown as X402PaymentRequired;
    } catch {
      return null;
    }
  }
  try {
    const body = JSON.parse(bodyText) as Partial<X402PaymentRequired>;
    return body && Array.isArray(body.accepts) ? (body as X402PaymentRequired) : null;
  } catch {
    return null;
  }
}

export async function probeX402Link(link: string, opts: ProbeOptions): Promise<ProbeResult> {
  const doFetch = opts.fetch ?? fetch;
  const resolve = opts.resolve ?? dnsResolve;
  const allowed = new Set(opts.allowOrigins.map(normOrigin).filter(Boolean));
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, reason: "not a valid link" };
  }
  for (let hop = 0; hop <= (opts.maxRedirects ?? 2); hop++) {
    const why = await refuse(url, allowed, resolve);
    if (why) return { ok: false, reason: why };
    let res: Response;
    try {
      res = await doFetch(url.href, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", credentials: "omit", signal: deadline });
    } catch (err) {
      return { ok: false, reason: deadline.aborted ? `${url.host} did not answer in time` : `could not reach ${url.host}: ${(err as Error).message}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return { ok: false, reason: `${url.host} answered ${res.status} without a location` };
      try {
        url = new URL(loc, url);
      } catch {
        return { ok: false, reason: `${url.host} redirected to an invalid link` };
      }
      continue;
    }
    if (res.status !== 402) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `${url.host} answered ${res.status}, not 402 Payment Required` };
    }
    let text = "";
    try {
      text = (await res.text()).slice(0, 20_000);
    } catch {
      /* header is what matters */
    }
    const challenge = decodeChallenge(res, text);
    if (!challenge) return { ok: false, reason: `${url.host} answered 402 without an x402 payment request` };
    const offer = (challenge.accepts ?? []).find(
      (a) => a && a.scheme === "exact" && a.network === opts.network && String(a.asset).toLowerCase() === opts.asset.toLowerCase() && /^\d{1,30}$/.test(String(a.amount)),
    );
    if (!offer) return { ok: false, reason: `${url.host} asks for payment, but not in USDC on ${opts.network}` };
    const desc = typeof challenge.resource?.description === "string" ? challenge.resource.description.replace(/\s+/g, " ").trim() : "";
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return {
      ok: true,
      probe: {
        url: url.href,
        baseUrl,
        host: url.host,
        name: (desc || url.host).slice(0, 60).trim(),
        ...(desc ? { description: desc.slice(0, 200) } : {}),
        requirements: { ...offer, amount: String(offer.amount) },
      },
    };
  }
  return { ok: false, reason: "too many redirects" };
}
