import { newId, toBaseUnits, toDollars, type Address, type AgentWorkErrorCode, type PayoutResponse } from "@allowance/shared";
import { getAddress, isAddress } from "viem";

/** What a site configures for one bounty. */
export interface BountyConfig {
  /** Stable, URL-safe id. */
  id: string;
  title: string;
  description: string;
  /** Free-form routing hint for agents, e.g. "api_reliability_check". */
  taskType: string;
  /** Everything the agent needs to do the task. Returned on claim too. */
  input: Record<string, unknown>;
  /** Decimal dollar string, e.g. "0.50". */
  payoutAmount: string;
  /** Total concurrent slots. */
  slots: number;
  /** Seconds a claim is held before returning to the pool. Default 600. */
  claimTtlSeconds?: number;
  /** Human note: how work is verified. */
  verification: string;
  /** "closed" bounties are listed but never claimable. Default "open". */
  status?: "open" | "closed";
}

export const DEFAULT_CLAIM_TTL_SECONDS = 600;

export type ClaimStatus = "claimed" | "paying" | "paid" | "expired";

export interface Claim {
  claimId: string;
  bountyId: string;
  /** Checksummed. */
  walletAddress: Address;
  agentName?: string;
  status: ClaimStatus;
  createdAt: number;
  /** Epoch ms. */
  expiresAt: number;
  /** Set once paid; returned verbatim on repeat submits. */
  payout?: PayoutResponse;
  /** True while a submit is in flight; busy claims never expire. */
  busy: boolean;
}

export type ClaimResult =
  | { ok: true; claim: Claim }
  | { ok: false; code: Extract<AgentWorkErrorCode, "bounty_not_found" | "bounty_full" | "already_claimed">; message: string };

export interface BountyStoreOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Called for each claim that transitions to `expired`. */
  onExpire?: (claim: Claim) => void;
}

/** Normalize a wallet address to its checksummed form, or null if invalid. */
export function normalizeAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) return null;
  return getAddress(value);
}

/**
 * In-memory bounty + claim state. All mutations are synchronous, so a burst of concurrent
 * claims is resolved in arrival order with no over-allocation. Expiry is lazy (on access)
 * plus whatever periodic `sweep()` the caller schedules.
 */
export class BountyStore {
  private readonly bounties = new Map<string, BountyConfig>();
  private readonly claims = new Map<string, Claim>();
  /** bountyId -> claimIds, for quick slot counting. */
  private readonly byBounty = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly onExpire?: (claim: Claim) => void;

  constructor(bounties: BountyConfig[], opts: BountyStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.onExpire = opts.onExpire;
    for (const b of bounties) {
      if (this.bounties.has(b.id)) throw new Error(`Duplicate bounty id: ${b.id}`);
      if (!Number.isInteger(b.slots) || b.slots < 0) throw new Error(`Bounty ${b.id}: slots must be a non-negative integer`);
      toBaseUnits(b.payoutAmount); // throws on malformed amounts at startup, not at payout time
      this.bounties.set(b.id, b);
      this.byBounty.set(b.id, new Set());
    }
  }

  listBounties(): BountyConfig[] {
    return [...this.bounties.values()];
  }

  getBounty(id: string): BountyConfig | undefined {
    return this.bounties.get(id);
  }

  /** Normalized "0.50" form of the payout. */
  payoutAmount(bountyId: string): string {
    const b = this.bounties.get(bountyId);
    if (!b) throw new Error(`Unknown bounty ${bountyId}`);
    return toDollars(toBaseUnits(b.payoutAmount));
  }

  ttlSeconds(bountyId: string): number {
    return this.bounties.get(bountyId)?.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
  }

  /** Slots not held by a claimed, paying or paid claim. */
  remaining(bountyId: string): number {
    const b = this.bounties.get(bountyId);
    if (!b) return 0;
    this.sweepBounty(bountyId);
    let used = 0;
    for (const id of this.byBounty.get(bountyId) ?? []) {
      const c = this.claims.get(id)!;
      if (c.status !== "expired") used++;
    }
    return Math.max(0, b.slots - used);
  }

  /** Open / closed / full, per spec §3. */
  status(bountyId: string): "open" | "full" | "closed" {
    const b = this.bounties.get(bountyId);
    if (!b) throw new Error(`Unknown bounty ${bountyId}`);
    if (b.status === "closed") return "closed";
    return this.remaining(bountyId) === 0 ? "full" : "open";
  }

  /** Synchronous check-and-set. First come, first served. */
  tryClaim(bountyId: string, walletAddress: Address, agentName?: string): ClaimResult {
    const b = this.bounties.get(bountyId);
    if (!b) return { ok: false, code: "bounty_not_found", message: `No bounty with id "${bountyId}".` };
    if (b.status === "closed") return { ok: false, code: "bounty_full", message: "This bounty is closed." };
    this.sweepBounty(bountyId);
    const wallet = walletAddress.toLowerCase();
    for (const id of this.byBounty.get(bountyId)!) {
      const c = this.claims.get(id)!;
      if (c.status !== "expired" && c.walletAddress.toLowerCase() === wallet) {
        return {
          ok: false,
          code: "already_claimed",
          message:
            c.status === "paid"
              ? "This wallet has already completed this bounty."
              : "This wallet already holds a slot on this bounty.",
        };
      }
    }
    if (this.remaining(bountyId) <= 0) {
      return { ok: false, code: "bounty_full", message: "No slots remaining. Slots return when claims expire." };
    }
    const now = this.now();
    const claim: Claim = {
      claimId: newId("clm"),
      bountyId,
      walletAddress,
      agentName,
      status: "claimed",
      createdAt: now,
      expiresAt: now + this.ttlSeconds(bountyId) * 1000,
      busy: false,
    };
    this.claims.set(claim.claimId, claim);
    this.byBounty.get(bountyId)!.add(claim.claimId);
    return { ok: true, claim };
  }

  /** Lazy-expires before returning. */
  getClaim(claimId: string): Claim | undefined {
    const c = this.claims.get(claimId);
    if (c) this.expireIfDue(c);
    return c;
  }

  setBusy(claimId: string, busy: boolean): void {
    const c = this.claims.get(claimId);
    if (c) c.busy = busy;
  }

  markPaying(claimId: string): void {
    this.transition(claimId, "paying");
  }

  /** Marks paid and stores the response that every later submit will replay. */
  markPaid(claimId: string, payout: PayoutResponse): void {
    const c = this.transition(claimId, "paid");
    c.payout = payout;
  }

  /** After a payout failure: the claim stays open so the agent can retry. */
  revertToClaimed(claimId: string): void {
    this.transition(claimId, "claimed");
  }

  /** Expire every due claim across all bounties. Returns how many expired. */
  sweep(): number {
    let n = 0;
    for (const c of this.claims.values()) if (this.expireIfDue(c)) n++;
    return n;
  }

  private sweepBounty(bountyId: string): void {
    for (const id of this.byBounty.get(bountyId) ?? []) this.expireIfDue(this.claims.get(id)!);
  }

  private expireIfDue(c: Claim): boolean {
    if (c.status !== "claimed" || c.busy) return false;
    if (this.now() < c.expiresAt) return false;
    c.status = "expired";
    this.onExpire?.(c);
    return true;
  }

  private transition(claimId: string, status: ClaimStatus): Claim {
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`Unknown claim ${claimId}`);
    c.status = status;
    return c;
  }
}
