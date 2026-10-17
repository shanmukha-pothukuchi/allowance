/**
 * In-memory wallet-service stand-in. Seeds the 8 demo agents and emits a believable
 * live stream: a scripted opening that mirrors the demo acts (bounty race, small
 * payments, a pizza that needs approval, a poisoned-bounty block + freeze), then a
 * steady random mix. Deterministic given a seed; timers are plain setTimeout so tests
 * can drive it with fake timers or call `tick()` directly.
 */
import { addDollars, describeEvent, fromCents, toCents } from "../format";
import type { Address, AgentPublic, Approval, ConnectionStatus, EventType, Hex, Policy, Receipt, SummaryResponse, WalletEvent } from "../types";
import type { WalletAdapter } from "./adapter";

export interface MockOptions {
  seed?: number;
  /** Clock, for deterministic timestamps in tests. */
  now?: () => number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Delay between payment.signed and payment.settled. */
  settleDelayMs?: number;
  /** Simulated request latency for owner actions. */
  latencyMs?: number;
}

export interface MockAdapter extends WalletAdapter {
  /** Advance the script by one step without waiting for the timer. Returns the emitted events. */
  tick(): WalletEvent[];
  stop(): void;
  /** Number of listeners (test helper). */
  listenerCount(): number;
}

const MERCHANT_ORIGIN = "http://localhost:4021";
const MERCHANT_ADDRESS = "0x9A3c0F1b7D2e4C5a6B7C8d9E0F1a2B3c4D5E6F70" as Address;
const ATTACKER_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;
const NETWORK = "eip155:84532";

function rngFrom(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AgentSeed = { name: string; policy: Partial<Policy> };
const AGENT_SEEDS: AgentSeed[] = [
  { name: "claude-desktop", policy: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: { addresses: [], origins: [MERCHANT_ORIGIN] } } },
  { name: "researcher", policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00" } },
  { name: "shopper", policy: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00" } },
  { name: "naive-worker", policy: { maxPerTx: "2.00", dailyCap: "10.00", approvalThreshold: "2.00", allowlist: { addresses: [], origins: [MERCHANT_ORIGIN] } } },
  { name: "worker-1", policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00" } },
  { name: "worker-2", policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00" } },
  { name: "worker-3", policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00" } },
  { name: "worker-4", policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00" } },
];

const PAID_APIS = [
  { name: "Acme Weather", amount: "0.05", url: `${MERCHANT_ORIGIN}/api/weather` },
  { name: "Acme News", amount: "0.10", url: `${MERCHANT_ORIGIN}/api/news` },
  { name: "Acme Stocks", amount: "0.15", url: `${MERCHANT_ORIGIN}/api/stock` },
];
const MERCHANT_NAMES: Record<string, string> = {
  "Pizza order": "Acme Pizza",
  "Domain renewal": "Acme Domains",
  "Dataset download": "Acme Data",
};
const BOUNTIES = [
  { name: "Bounty: API reliability check", amount: "0.50" },
  { name: "Bounty: Summarize changelog", amount: "0.75" },
];

type Step =
  | { kind: "earn"; agent: string; bounty: number }
  | { kind: "pay"; agent: string; api: number }
  | { kind: "needs_approval"; agent: string; description: string; amount: string }
  | { kind: "blocked"; agent: string; amount?: string };

/** The scripted opening: what a first-time viewer sees in the first ~30 s. */
const OPENING: Step[] = [
  { kind: "earn", agent: "worker-1", bounty: 0 },
  { kind: "pay", agent: "researcher", api: 0 },
  { kind: "earn", agent: "worker-2", bounty: 0 },
  { kind: "pay", agent: "researcher", api: 1 },
  { kind: "needs_approval", agent: "shopper", description: "Pizza order", amount: "18.50" },
  { kind: "earn", agent: "worker-3", bounty: 0 },
  { kind: "blocked", agent: "naive-worker" },
  { kind: "pay", agent: "claude-desktop", api: 2 },
];

export function createMockAdapter(opts: MockOptions = {}): MockAdapter {
  const rand = rngFrom(opts.seed ?? 42);
  const now = opts.now ?? (() => Date.now());
  const minI = opts.minIntervalMs ?? 2000;
  const maxI = opts.maxIntervalMs ?? 4000;
  const settleDelay = opts.settleDelayMs ?? 900;
  const latency = opts.latencyMs ?? 120;

  let seq = 0;
  const id = (prefix: string) => `${prefix}_${(++seq).toString(36).padStart(6, "0")}`;
  const hex = (bytes: number): Hex => {
    let s = "0x";
    for (let i = 0; i < bytes; i++) s += Math.floor(rand() * 256).toString(16).padStart(2, "0");
    return s as Hex;
  };
  const iso = () => new Date(now()).toISOString();
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

  const agents: AgentPublic[] = AGENT_SEEDS.map((s) => ({
    id: id("agt"),
    name: s.name,
    address: hex(20) as Address,
    policy: {
      maxPerTx: "5.00",
      dailyCap: "25.00",
      allowlist: null,
      approvalThreshold: "10.00",
      frozen: false,
      freezeOnViolation: true,
      ...s.policy,
    },
    createdAt: iso(),
    balance: "20.00",
    spentToday: "0.00",
    earnedToday: "0.00",
    frozen: false,
  }));
  const receipts: Receipt[] = [];
  const approvals: Approval[] = [];
  const events: WalletEvent[] = [];
  const listeners = new Set<(e: WalletEvent) => void>();
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let script = OPENING.slice();
  let blockedOnce = false;
  let ticker: ReturnType<typeof setTimeout> | undefined;

  const byName = (name: string) => agents.find((a) => a.name === name)!;
  const byId = (agentId: string) => agents.find((a) => a.id === agentId);

  function emit(type: EventType, agent: AgentPublic | undefined, extra: Partial<WalletEvent> = {}): WalletEvent {
    const base = { type, agentName: agent?.name, receipt: extra.receipt, approval: extra.approval, reason: extra.reason, data: extra.data, message: extra.message ?? "" };
    const e: WalletEvent = {
      id: id("evt"),
      at: iso(),
      agentId: agent?.id,
      ...base,
      message: describeEvent(base),
    };
    events.unshift(e);
    if (events.length > 500) events.length = 500;
    for (const l of listeners) l(e);
    return e;
  }

  function later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  }

  function makeReceipt(agent: AgentPublic, partial: Partial<Receipt> & Pick<Receipt, "kind" | "status" | "description" | "amount" | "counterparty">): Receipt {
    const r: Receipt = {
      id: id("rcp"),
      agentId: agent.id,
      agentName: agent.name,
      amountBaseUnits: String(toCents(partial.amount) * 10_000),
      network: NETWORK,
      createdAt: iso(),
      ...partial,
    };
    receipts.unshift(r);
    return r;
  }

  function settle(r: Receipt, agent: AgentPublic) {
    later(settleDelay, () => {
      r.status = "settled";
      r.txHash = hex(32);
      r.explorerUrl = `http://localhost:4030/tx/${r.txHash}`;
      r.settledAt = iso();
      agent.balance = fromCents(toCents(agent.balance) - toCents(r.amount));
      emit("payment.settled", agent, { receipt: { ...r } });
    });
  }

  function doPay(agent: AgentPublic, api: (typeof PAID_APIS)[number]): WalletEvent[] {
    if (agent.frozen) return [];
    const r = makeReceipt(agent, {
      kind: "spend",
      status: "signed",
      description: api.name,
      amount: api.amount,
      counterparty: { address: MERCHANT_ADDRESS, origin: MERCHANT_ORIGIN, name: api.name },
      paymentId: id("pay"),
    });
    agent.spentToday = addDollars(agent.spentToday, api.amount);
    const e = emit("payment.signed", agent, { receipt: { ...r } });
    settle(r, agent);
    return [e];
  }

  function doEarn(agent: AgentPublic, bounty: (typeof BOUNTIES)[number]): WalletEvent[] {
    const tx = hex(32);
    const r = makeReceipt(agent, {
      kind: "earn",
      status: "settled",
      description: bounty.name,
      amount: bounty.amount,
      counterparty: { address: MERCHANT_ADDRESS, origin: MERCHANT_ORIGIN, name: "Acme Corp" },
      txHash: tx,
      explorerUrl: `http://localhost:4030/tx/${tx}`,
      settledAt: iso(),
    });
    agent.balance = addDollars(agent.balance, bounty.amount);
    agent.earnedToday = addDollars(agent.earnedToday, bounty.amount);
    return [emit("earning.received", agent, { receipt: { ...r } })];
  }

  function doNeedsApproval(agent: AgentPublic, description: string, amount: string): WalletEvent[] {
    if (agent.frozen) return [];
    const paymentId = id("pay");
    const approval: Approval = {
      id: id("apr"),
      agentId: agent.id,
      agentName: agent.name,
      paymentId,
      amount,
      description,
      counterparty: { address: MERCHANT_ADDRESS, origin: MERCHANT_ORIGIN, name: MERCHANT_NAMES[description] ?? "Acme Corp" },
      status: "pending",
      createdAt: iso(),
    };
    approvals.unshift(approval);
    const r = makeReceipt(agent, {
      kind: "spend",
      status: "pending_approval",
      description,
      amount,
      counterparty: approval.counterparty,
      paymentId,
      approvalId: approval.id,
    });
    return [emit("payment.needs_approval", agent, { receipt: { ...r }, approval: { ...approval } })];
  }

  function doBlocked(agent: AgentPublic, amount = agent.balance): WalletEvent[] {
    const r = makeReceipt(agent, {
      kind: "transfer",
      status: "blocked",
      description: "Transfer",
      amount,
      counterparty: { address: ATTACKER_ADDRESS },
      reason: "not_allowlisted",
    });
    const message = `Blocked: tried to send ${"$" + amount} to an unknown address. Agent frozen.`;
    const out = [emit("payment.blocked", agent, { receipt: { ...r }, reason: "not_allowlisted", message })];
    agent.frozen = true;
    agent.policy = { ...agent.policy, frozen: true };
    agent.frozenReason = message;
    out.push(emit("agent.frozen", agent, { reason: message, message: `${agent.name} is frozen. ${message}` }));
    return out;
  }

  function doTopup(agent: AgentPublic, amount: string): Receipt {
    const tx = hex(32);
    const r = makeReceipt(agent, {
      kind: "topup",
      status: "settled",
      description: "Added with card (demo)",
      amount,
      counterparty: { address: agent.address, name: "Card top-up" },
      txHash: tx,
      explorerUrl: `http://localhost:4030/tx/${tx}`,
      settledAt: iso(),
    });
    agent.balance = addDollars(agent.balance, amount);
    emit("topup", agent, { receipt: { ...r } });
    return r;
  }

  function randomStep(): Step {
    const roll = rand();
    if (roll < 0.42) return { kind: "pay", agent: pick(["researcher", "claude-desktop", "shopper"]), api: Math.floor(rand() * PAID_APIS.length) };
    if (roll < 0.86) return { kind: "earn", agent: pick(["worker-1", "worker-2", "worker-3", "worker-4", "claude-desktop"]), bounty: Math.floor(rand() * BOUNTIES.length) };
    if (roll < 0.94 && approvals.every((a) => a.status !== "pending")) {
      return { kind: "needs_approval", agent: pick(["shopper", "claude-desktop"]), description: pick(["Pizza order", "Domain renewal", "Dataset download"]), amount: pick(["18.50", "12.00", "14.99"]) };
    }
    return { kind: "earn", agent: pick(["worker-1", "worker-4"]), bounty: 0 };
  }

  function runStep(step: Step): WalletEvent[] {
    const agent = byName(step.agent);
    switch (step.kind) {
      case "earn":
        return doEarn(agent, BOUNTIES[step.bounty]);
      case "pay":
        return doPay(agent, PAID_APIS[step.api]);
      case "needs_approval":
        return doNeedsApproval(agent, step.description, step.amount);
      case "blocked":
        if (blockedOnce) return [];
        blockedOnce = true;
        return doBlocked(agent, step.amount);
    }
  }

  function tick(): WalletEvent[] {
    const step = script.length ? script.shift()! : randomStep();
    const out = runStep(step);
    return out.length ? out : tick();
  }

  function schedule() {
    if (ticker) return;
    const wait = minI + Math.floor(rand() * (maxI - minI + 1));
    ticker = setTimeout(() => {
      ticker = undefined;
      if (listeners.size === 0) return;
      tick();
      schedule();
    }, wait);
  }

  function stop() {
    if (ticker) clearTimeout(ticker);
    ticker = undefined;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  const delay = <T>(v: () => T): Promise<T> => new Promise((res, rej) => later(latency, () => {
    try {
      res(v());
    } catch (err) {
      rej(err);
    }
  }));

  const summary = (): SummaryResponse => ({
    totalBalance: agents.reduce((s, a) => addDollars(s, a.balance), "0.00"),
    spentToday: agents.reduce((s, a) => addDollars(s, a.spentToday), "0.00"),
    earnedToday: agents.reduce((s, a) => addDollars(s, a.earnedToday), "0.00"),
    agents: agents.map((a) => ({ ...a, policy: { ...a.policy } })),
    pendingApprovals: approvals.filter((a) => a.status === "pending").map((a) => ({ ...a })),
    chainMode: "mock",
    telegramConnected: false,
  });

  return {
    kind: "mock",
    tick,
    stop,
    listenerCount: () => listeners.size,
    getSummary: () => delay(summary),
    getAgents: () => delay(() => summary().agents),
    getReceipts: (limit = 50) => delay(() => receipts.slice(0, limit).map((r) => ({ ...r }))),
    getRecentEvents: (limit = 100) => delay(() => events.slice(0, limit)),
    getPendingApprovals: () => delay(() => summary().pendingApprovals),
    approve: (approvalId) =>
      delay(() => {
        const a = approvals.find((x) => x.id === approvalId);
        if (!a || a.status !== "pending") throw new Error("Approval is no longer pending.");
        const agent = byId(a.agentId)!;
        a.status = "approved";
        a.decidedAt = iso();
        a.decidedBy = "dashboard";
        const r = receipts.find((x) => x.id && x.approvalId === a.id)!;
        r.status = "signed";
        agent.spentToday = addDollars(agent.spentToday, r.amount);
        emit("approval.approved", agent, { receipt: { ...r }, approval: { ...a } });
        settle(r, agent);
        return { ...a };
      }),
    deny: (approvalId) =>
      delay(() => {
        const a = approvals.find((x) => x.id === approvalId);
        if (!a || a.status !== "pending") throw new Error("Approval is no longer pending.");
        const agent = byId(a.agentId)!;
        a.status = "denied";
        a.decidedAt = iso();
        a.decidedBy = "dashboard";
        const r = receipts.find((x) => x.approvalId === a.id)!;
        r.status = "denied";
        r.reason = "denied by owner";
        emit("approval.denied", agent, { receipt: { ...r }, approval: { ...a } });
        return { ...a };
      }),
    freeze: (agentId) =>
      delay(() => {
        const agent = byId(agentId);
        if (!agent) throw new Error("No such agent.");
        agent.frozen = true;
        agent.policy = { ...agent.policy, frozen: true };
        agent.frozenReason = "Frozen by you from the dashboard.";
        emit("agent.frozen", agent, { reason: agent.frozenReason });
        return { ...agent };
      }),
    unfreeze: (agentId) =>
      delay(() => {
        const agent = byId(agentId);
        if (!agent) throw new Error("No such agent.");
        agent.frozen = false;
        agent.policy = { ...agent.policy, frozen: false };
        agent.frozenReason = undefined;
        emit("agent.unfrozen", agent);
        return { ...agent };
      }),
    topup: (agentId, amount) =>
      delay(() => {
        const agent = byId(agentId);
        if (!agent) throw new Error("No such agent.");
        return { ...doTopup(agent, amount) };
      }),
    subscribe(onEvent, onStatus) {
      listeners.add(onEvent);
      if (onStatus) {
        statusListeners.add(onStatus);
        onStatus("demo");
      }
      schedule();
      return () => {
        listeners.delete(onEvent);
        if (onStatus) statusListeners.delete(onStatus);
        if (listeners.size === 0) {
          if (ticker) clearTimeout(ticker);
          ticker = undefined;
        }
      };
    },
  };
}
