/**
 * JSON state store for the wallet-service. One file, atomic writes (temp + rename).
 * This is the ONLY place agent private keys live. Never serve `state` directly.
 */
import { isAddress, getAddress } from "viem";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_POLICY,
  hashToken,
  newAgentToken,
  newId,
  nowIso,
  toBaseUnits,
  toDollars,
} from "@allowance/shared";
import type { Address, AgentPublic, AgentToken, Approval, Hex, Policy, Receipt, WalletEvent, X402PaymentRequired, X402PaymentRequirements } from "@allowance/shared";

export interface StoredAgent {
  id: string;
  name: string;
  address: Address;
  /** NEVER leaves this process. redact() strips this key name everywhere. */
  privateKey: Hex;
  policy: Policy;
  createdAt: string;
  frozenReason?: string;
  /** Mock mode: dollars to mint at startup if not yet applied. */
  seedBalance?: string;
  seedApplied?: boolean;
}

export interface StoredToken {
  id: string;
  agentId: string;
  hash: string;
  hint: string;
  createdAt: string;
  revokedAt?: string;
}

/** A payment or transfer parked for owner approval, or already signed (header kept for /wait). */
export interface PendingPayment {
  paymentId: string;
  approvalId?: string;
  agentId: string;
  receiptId: string;
  kind: "pay" | "transfer";
  amountBaseUnits: string;
  to: Address;
  origin?: string;
  // pay
  paymentRequired?: X402PaymentRequired;
  requirements?: X402PaymentRequirements;
  paymentHeader?: string;
  /** Original request (url/method/body) so /wait can hand it back to a restarted agent. */
  request?: { url: string; method?: "GET" | "POST"; body?: unknown };
  // transfer
  memo?: string;
  createdAt: string;
}

export interface WalletState {
  version: 1;
  agents: StoredAgent[];
  tokens: StoredToken[];
  receipts: Receipt[];
  approvals: Approval[];
  events: WalletEvent[];
  pendingPayments: Record<string, PendingPayment>;
}

export const MAX_EVENTS = 500;

export function emptyState(): WalletState {
  return { version: 1, agents: [], tokens: [], receipts: [], approvals: [], events: [], pendingPayments: {} };
}

export class Store {
  state: WalletState;
  readonly file: string;

  constructor(readonly dataDir: string) {
    this.file = join(dataDir, "wallet-state.json");
    this.state = this.load();
  }

  private load(): WalletState {
    if (!existsSync(this.file)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WalletState>;
      return { ...emptyState(), ...parsed };
    } catch (err) {
      console.error(`[wallet-service] could not parse ${this.file}; starting empty`, (err as Error).message);
      return emptyState();
    }
  }

  /** Atomic: write temp + rename. Synchronous so callers never observe a half-saved state. */
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  agentById(id: string): StoredAgent | undefined {
    return this.state.agents.find((a) => a.id === id);
  }

  agentByName(name: string): StoredAgent | undefined {
    return this.state.agents.find((a) => a.name === name);
  }

  tokenByHash(hash: string): StoredToken | undefined {
    return this.state.tokens.find((t) => t.hash === hash);
  }

  receiptById(id: string): Receipt | undefined {
    return this.state.receipts.find((r) => r.id === id);
  }

  approvalById(id: string): Approval | undefined {
    return this.state.approvals.find((a) => a.id === id);
  }

  /** All private keys, for defense-in-depth output scrubbing. */
  secrets(): string[] {
    return this.state.agents.map((a) => a.privateKey);
  }
}

export function openStore(dataDir: string): Store {
  return new Store(dataDir);
}

export function publicToken(t: StoredToken): AgentToken {
  return { id: t.id, agentId: t.agentId, hint: t.hint, createdAt: t.createdAt, revokedAt: t.revokedAt };
}

export interface AgentFigures {
  balance: bigint;
  spentToday: bigint;
  earnedToday: bigint;
}

export function toAgentPublic(a: StoredAgent, figures: AgentFigures): AgentPublic {
  return {
    id: a.id,
    name: a.name,
    address: a.address,
    policy: a.policy,
    createdAt: a.createdAt,
    balance: toDollars(figures.balance),
    spentToday: toDollars(figures.spentToday),
    earnedToday: toDollars(figures.earnedToday),
    frozen: a.policy.frozen,
    frozenReason: a.policy.frozen ? a.frozenReason : undefined,
  };
}

/** Validate + normalize a partial policy; throws on bad values. */
export function normalizePolicy(base: Policy, patch: Partial<Policy> | undefined): Policy {
  const p: Policy = { ...base, ...(patch ?? {}) };
  for (const k of ["maxPerTx", "dailyCap", "approvalThreshold"] as const) {
    const v = toBaseUnits(p[k]);
    if (v < 0n) throw new Error(`${k} must be >= 0`);
    p[k] = toDollars(v);
  }
  if (p.allowlist !== null && p.allowlist !== undefined) {
    if (typeof p.allowlist !== "object") throw new Error("allowlist must be an object or null");
    const addresses = Array.isArray(p.allowlist.addresses) ? p.allowlist.addresses : [];
    const origins = Array.isArray(p.allowlist.origins) ? p.allowlist.origins : [];
    for (const a of addresses) if (typeof a !== "string" || !isAddress(a)) throw new Error(`allowlist address is not a 0x address: ${String(a)}`);
    const normOrigins = origins.map((o) => {
      try {
        return new URL(String(o)).origin;
      } catch {
        throw new Error(`allowlist origin is not a URL origin: ${String(o)}`);
      }
    });
    p.allowlist = { addresses: addresses.map((a) => getAddress(a)), origins: normOrigins };
  } else {
    p.allowlist = null;
  }
  for (const k of ["frozen", "freezeOnViolation"] as const) {
    if (patch && k in patch && typeof patch[k] !== "boolean") throw new Error(`${k} must be a boolean`);
  }
  p.frozen = Boolean(p.frozen);
  p.freezeOnViolation = p.freezeOnViolation !== false;
  return p;
}

export function issueToken(store: Store, agentId: string): { token: string; stored: StoredToken } {
  const token = newAgentToken();
  const stored: StoredToken = {
    id: newId("tok"),
    agentId,
    hash: hashToken(token),
    hint: token.slice(-4),
    createdAt: nowIso(),
  };
  store.state.tokens.push(stored);
  return { token, stored };
}

/**
 * Create an agent without the server running (used by `npm run setup`).
 * Generates the key, stores it only in wallet-state.json, returns the token once.
 * In mock mode the wallet-service mints `initialBalance` on its next startup.
 */
export function createAgentOffline(
  store: Store,
  input: { name: string; policy?: Partial<Policy>; initialBalance?: string },
): { agent: AgentPublic; token: string; tokenId: string; stored: StoredAgent } {
  if (!input.name || typeof input.name !== "string") throw new Error("name is required");
  if (store.agentByName(input.name)) throw new Error(`agent "${input.name}" already exists`);
  if (input.initialBalance !== undefined && toBaseUnits(input.initialBalance) < 0n) throw new Error("initialBalance must be >= 0");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const stored: StoredAgent = {
    id: newId("agt"),
    name: input.name,
    address: account.address,
    privateKey,
    policy: normalizePolicy(DEFAULT_POLICY, input.policy),
    createdAt: nowIso(),
    seedBalance: input.initialBalance ? toDollars(toBaseUnits(input.initialBalance)) : undefined,
    seedApplied: input.initialBalance ? false : undefined,
  };
  store.state.agents.push(stored);
  const { token, stored: tok } = issueToken(store, stored.id);
  store.save();
  return {
    agent: toAgentPublic(stored, { balance: 0n, spentToday: 0n, earnedToday: 0n }),
    token,
    tokenId: tok.id,
    stored,
  };
}
