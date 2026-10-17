import { formatUsd, toBaseUnits } from "@allowance/shared";
import type { Policy, PolicyBlockReason, PolicyDecision, ServiceGrant, SpendRequest } from "@allowance/shared";

/** The parts of a service (connected or listed in the directory) the policy engine looks at. */
export type ServiceRef = Pick<ServiceGrant, "id" | "name" | "kind" | "baseUrl" | "maxPrice">;

export interface EvaluateOptions {
  /** The agent's connected services. A connected x402 service allowlists URLs under its `baseUrl`. */
  services?: readonly ServiceRef[];
  /**
   * The directory catalog, if known. When a payment is not allowlisted but its URL falls under a
   * directory x402 service, the block is the soft `service_not_connected` instead of `not_allowlisted`.
   * Leave it out (e.g. the directory is unreachable) to get plain `not_allowlisted`.
   */
  directory?: readonly ServiceRef[];
  /** Used in the `service_not_connected` message. */
  agentName?: string;
}

/** How a spend got past the allowlist. */
export type AllowlistMatch = { via: "address" } | { via: "origin" } | { via: "service"; service: ServiceRef };

/**
 * Pure policy engine. Order of checks:
 *   frozen → max_per_tx → daily_cap → allowlist (address · origin · connected service, else
 *   service_not_connected / not_allowlisted) → service_cap → approval threshold → allow.
 * Block messages are owner-friendly and in dollars; the wallet-service appends
 * " Agent frozen." when it freezes the agent.
 */
export function evaluate(
  policy: Policy,
  spentTodayBaseUnits: bigint,
  request: SpendRequest,
  opts: EvaluateOptions = {},
): PolicyDecision {
  const amount = request.amountBaseUnits;
  const dollars = formatUsd(amount);
  const where = describeCounterparty(request);

  if (policy.frozen) {
    return block("frozen", `Blocked: agent is frozen; tried to send ${dollars}${where}.`);
  }

  const maxPerTx = toBaseUnits(policy.maxPerTx);
  if (amount > maxPerTx) {
    return block(
      "max_per_tx",
      `Blocked: tried to send ${dollars}${where}, over the ${formatUsd(maxPerTx)} per-payment limit.`,
    );
  }

  const dailyCap = toBaseUnits(policy.dailyCap);
  if (spentTodayBaseUnits + amount > dailyCap) {
    return block(
      "daily_cap",
      `Blocked: tried to send ${dollars}${where}, which would pass the ${formatUsd(dailyCap)} daily cap (${formatUsd(spentTodayBaseUnits)} already spent today).`,
    );
  }

  if (policy.allowlist !== null) {
    const match = allowlistMatch(policy.allowlist, request, opts.services);
    if (!match) {
      const known = request.url && opts.directory ? findService(request.url, opts.directory) : undefined;
      if (known) {
        return block(
          "service_not_connected",
          `${known.name} is not connected for ${opts.agentName ?? "this agent"}. Ask the owner with request_service.`,
        );
      }
      const what = request.origin ? `an unknown site (${request.origin})` : "an unknown address";
      return block("not_allowlisted", `Blocked: tried to send ${dollars} to ${what}.`);
    }
    if (match.via === "service") {
      const cap = safeBaseUnits(match.service.maxPrice);
      if (amount > cap) {
        return block(
          "service_cap",
          `Blocked: tried to send ${dollars} to ${match.service.name}, over its ${formatUsd(cap)} per-payment cap.`,
        );
      }
    }
  }

  const threshold = toBaseUnits(policy.approvalThreshold);
  if (amount > threshold) {
    return { outcome: "needs_approval", reason: "over_approval_threshold" };
  }

  return { outcome: "allow" };
}

/**
 * True if `to` is in `addresses`, or `origin` is in `origins`, or `url` falls under a connected x402
 * service's `baseUrl`. Direct transfers have no origin or URL, so they must match `addresses`.
 */
export function isAllowlisted(
  allowlist: NonNullable<Policy["allowlist"]>,
  request: Pick<SpendRequest, "to" | "origin" | "url">,
  services?: readonly ServiceRef[],
): boolean {
  return allowlistMatch(allowlist, request, services) !== null;
}

/** Which allowlist rule lets this spend through (address, then origin, then connected service), or null. */
export function allowlistMatch(
  allowlist: NonNullable<Policy["allowlist"]>,
  request: Pick<SpendRequest, "to" | "origin" | "url">,
  services: readonly ServiceRef[] = [],
): AllowlistMatch | null {
  const to = request.to.toLowerCase();
  if (allowlist.addresses.some((a) => a.toLowerCase() === to)) return { via: "address" };
  if (request.origin) {
    const origin = normalizeOrigin(request.origin);
    if (allowlist.origins.some((o) => normalizeOrigin(o) === origin)) return { via: "origin" };
  }
  if (request.url) {
    const service = findService(request.url, services);
    if (service) return { via: "service", service };
  }
  return null;
}

/**
 * The x402 service whose `baseUrl` covers `url` (most specific wins), or undefined.
 * Agent-work and directory services never cover payments.
 */
export function findService<T extends ServiceRef>(url: string, services: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestLen = -1;
  for (const s of services) {
    if (s.kind !== "x402" || !urlMatchesBase(url, s.baseUrl)) continue;
    const len = basePath(s.baseUrl)?.length ?? 0;
    if (len > bestLen) {
      best = s;
      bestLen = len;
    }
  }
  return best;
}

/**
 * Path-boundary prefix match after URL normalization (scheme/host case, default ports, dot segments).
 * `http://x/pizza` covers `/pizza`, `/pizza/`, `/pizza/order` and `/pizza?x=1`, but not `/pizzas`.
 * Query and fragment of `url` are ignored; anything that does not parse never matches.
 */
export function urlMatchesBase(url: string, baseUrl: string): boolean {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(baseUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.origin.toLowerCase() !== b.origin.toLowerCase()) return false;
  const prefix = b.pathname.replace(/\/+$/, "");
  if (prefix === "") return true;
  return u.pathname === prefix || u.pathname.startsWith(`${prefix}/`);
}

function basePath(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return origin.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** A malformed cap never fails open: it caps at zero. */
function safeBaseUnits(dollars: string): bigint {
  try {
    const v = toBaseUnits(dollars);
    return v < 0n ? 0n : v;
  } catch {
    return 0n;
  }
}

function describeCounterparty(request: SpendRequest): string {
  if (request.origin) {
    try {
      return ` to ${new URL(request.origin).host}`;
    } catch {
      return ` to ${request.origin}`;
    }
  }
  return "";
}

function block(reason: PolicyBlockReason, message: string): PolicyDecision {
  return { outcome: "block", reason, message };
}
