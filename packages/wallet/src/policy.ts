import { formatUsd, toBaseUnits } from "@allowance/shared";
import type { Policy, PolicyBlockReason, PolicyDecision, SpendRequest } from "@allowance/shared";

/**
 * Pure policy engine. Order of checks:
 *   frozen → max_per_tx → daily_cap → allowlist → approval threshold → allow.
 * Block messages are owner-friendly and in dollars; the wallet-service appends
 * " Agent frozen." when it freezes the agent.
 */
export function evaluate(policy: Policy, spentTodayBaseUnits: bigint, request: SpendRequest): PolicyDecision {
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
    if (!isAllowlisted(policy.allowlist, request)) {
      const what = request.origin ? `an unknown site (${request.origin})` : "an unknown address";
      return block("not_allowlisted", `Blocked: tried to send ${dollars} to ${what}.`);
    }
  }

  const threshold = toBaseUnits(policy.approvalThreshold);
  if (amount > threshold) {
    return { outcome: "needs_approval", reason: "over_approval_threshold" };
  }

  return { outcome: "allow" };
}

/** True if `to` is in `addresses` or `origin` is in `origins`. Direct transfers have no origin. */
export function isAllowlisted(
  allowlist: NonNullable<Policy["allowlist"]>,
  request: Pick<SpendRequest, "to" | "origin">,
): boolean {
  const to = request.to.toLowerCase();
  if (allowlist.addresses.some((a) => a.toLowerCase() === to)) return true;
  if (request.origin) {
    const origin = normalizeOrigin(request.origin);
    if (allowlist.origins.some((o) => normalizeOrigin(o) === origin)) return true;
  }
  return false;
}

export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return origin.trim().replace(/\/+$/, "").toLowerCase();
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
