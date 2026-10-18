/**
 * Pure state + reducer for the dashboard. The hook feeds it the initial fetches and
 * then every SSE event; components only read from it. Unit-tested in state.test.ts.
 */
import { bankFromEvent, foldBankEvents, isBankEvent, patchReceiptBank } from "./bank";
import { isServiceApproval, serviceIdOfEvent, serviceOfEvent } from "./format";
import type {
  AgentPublic,
  Approval,
  BankSummary,
  ConnectedService,
  ConnectionStatus,
  DirectoryService,
  EventType,
  Receipt,
  SummaryResponse,
  WalletEvent,
} from "./types";

export const MAX_FEED = 200;
export const MAX_RECEIPTS = 100;

export interface Totals {
  totalBalance: string;
  spentToday: string;
  earnedToday: string;
  chainMode: SummaryResponse["chainMode"] | "unknown";
  telegramConnected: boolean;
  /** Owner's Capital One checking (§16.4), from the summary. null: no bank (no Nessie key). */
  bank: SummaryResponse["bank"] | null;
}

export interface DashboardState {
  agents: AgentPublic[];
  totals: Totals;
  events: WalletEvent[];
  receipts: Receipt[];
  approvals: Approval[];
  connection: ConnectionStatus;
  /** True when the HTTP wallet-service was unreachable and we fell back to mock data. */
  offlineFallback: boolean;
  showDetails: boolean;
  /** Ids of approvals with an approve/deny request in flight. */
  busyApprovals: string[];
  busyAgents: string[];
  /** `${agentId}:${serviceId}` keys with a connect/disconnect request in flight. */
  busyServices: string[];
  loaded: boolean;
  lastError?: string;
  /** The service directory (catalog). Connections come from `agents[].services`, not from here. */
  directory: DirectoryService[];
  directoryStatus: "idle" | "loading" | "ready" | "error";
  directoryError?: string;
  /** Usage docs fetched on demand, by service id. */
  serviceDocs: Record<string, string>;
  /** `GET /v1/bank` (§16.4): checking and every agent's allowance account. Loaded only when the summary has `bank`. */
  bank: BankSummary | null;
}

export const initialState: DashboardState = {
  agents: [],
  totals: { totalBalance: "0.00", spentToday: "0.00", earnedToday: "0.00", chainMode: "unknown", telegramConnected: false, bank: null },
  events: [],
  receipts: [],
  approvals: [],
  connection: "connecting",
  offlineFallback: false,
  showDetails: false,
  busyApprovals: [],
  busyAgents: [],
  busyServices: [],
  loaded: false,
  directory: [],
  directoryStatus: "idle",
  serviceDocs: {},
  bank: null,
};

export type Action =
  | { type: "loaded"; summary: SummaryResponse; events: WalletEvent[]; receipts: Receipt[]; approvals: Approval[] }
  | { type: "summary"; summary: SummaryResponse }
  | { type: "receipts"; receipts: Receipt[] }
  | { type: "approvals"; approvals: Approval[] }
  | { type: "event"; event: WalletEvent }
  | { type: "agent"; agent: AgentPublic }
  | { type: "connection"; status: ConnectionStatus; offlineFallback?: boolean }
  | { type: "toggleDetails" }
  | { type: "busyApproval"; id: string; busy: boolean }
  | { type: "busyAgent"; id: string; busy: boolean }
  | { type: "busyService"; key: string; busy: boolean }
  | { type: "directory"; services: DirectoryService[] }
  /** One entry added or changed (the owner just added a Shopify store, §15.3). */
  | { type: "directoryUpsert"; service: DirectoryService }
  | { type: "directoryError"; message: string }
  | { type: "directoryLoading" }
  | { type: "serviceDocs"; id: string; docs: string }
  | { type: "bank"; bank: BankSummary | null }
  /** `POST /v1/bank/retry` answered: that receipt (or every "Not on statement" one) is queued again. */
  | { type: "bankRetried"; receiptId?: string }
  | { type: "error"; message?: string };

const MONEY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "payment.signed",
  "payment.settled",
  "payment.blocked",
  "approval.approved",
  "transfer.sent",
  "earning.received",
  "topup",
  "cashout",
]);

/** Events after which balances / spent today may have changed and the summary should be refetched. */
export function isMoneyEvent(type: EventType): boolean {
  return MONEY_EVENTS.has(type);
}

/**
 * Events after which the summary (balances, agents, or their connected services) should be
 * refetched. `agent.created` too: the wallet may send it without `data.agent`.
 */
export function refreshesSummary(type: EventType): boolean {
  return isMoneyEvent(type) || type === "service.connected" || type === "service.disconnected" || type === "agent.created";
}

/** Busy key for one agent/service switch. */
export const serviceKey = (agentId: string, serviceId: string) => `${agentId}:${serviceId}`;

function totalsFrom(summary: SummaryResponse): Totals {
  return {
    totalBalance: summary.totalBalance,
    spentToday: summary.spentToday,
    earnedToday: summary.earnedToday,
    chainMode: summary.chainMode,
    telegramConnected: summary.telegramConnected,
    bank: summary.bank ?? null,
  };
}

function sortNewest<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function upsertReceipt(receipts: Receipt[], r: Receipt): Receipt[] {
  const idx = receipts.findIndex((x) => x.id === r.id);
  if (idx >= 0) {
    const next = receipts.slice();
    next[idx] = { ...receipts[idx], ...r };
    return next;
  }
  return [r, ...receipts].slice(0, MAX_RECEIPTS);
}

/** A wallet-service that predates §13 sends no `services`; never let that crash a render. */
function norm(agent: AgentPublic): AgentPublic {
  return Array.isArray(agent.services) ? agent : { ...agent, services: [] };
}
const normAll = (agents: AgentPublic[]) => agents.map(norm);

function upsertAgent(agents: AgentPublic[], raw: AgentPublic): AgentPublic[] {
  const agent = norm(raw);
  const idx = agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) {
    const next = agents.slice();
    next[idx] = { ...agents[idx], ...agent };
    return next;
  }
  return [...agents, agent];
}

function patchAgent(agents: AgentPublic[], id: string | undefined, patch: Partial<AgentPublic>): AgentPublic[] {
  if (!id) return agents;
  return agents.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

const approvalIdOf = (e: WalletEvent): string | undefined => e.approval?.id ?? e.receipt?.approvalId;
const frozenReceiptId = (e: WalletEvent): string | undefined => (e.data as { receiptId?: string } | undefined)?.receiptId;
const connectKey = (e: WalletEvent): string | undefined => {
  const sid = serviceIdOfEvent(e);
  const aid = e.agentId ?? e.approval?.agentId;
  return sid && aid ? `${aid}:${sid}` : undefined;
};

/**
 * One feed line per payment: a settlement replaces its own "is paying" row, and an owner decision
 * replaces its "Approve?" row. Used for live events and for the initial snapshot alike.
 * Services follow the same rule: a decision replaces its "wants to connect" row, and the
 * "Acme Pizza connected to shopper" row replaces the "Approved connecting…" row it caused.
 * A freeze caused by a block is folded into the block's row (same `data.receiptId`).
 */
export function collapseFeed(newestFirst: WalletEvent[]): WalletEvent[] {
  const settled = new Set<string>();
  const decided = new Set<string>();
  const connected = new Set<string>();
  const blocked = new Set<string>();
  for (const e of newestFirst) {
    if (e.type === "payment.blocked" && e.receipt) blocked.add(e.receipt.id);
    if (e.type === "payment.settled" && e.receipt) settled.add(e.receipt.id);
    if ((e.type === "approval.approved" || e.type === "approval.denied") && approvalIdOf(e)) decided.add(approvalIdOf(e)!);
    if (e.type === "service.connected" && connectKey(e)) connected.add(connectKey(e)!);
  }
  return newestFirst.filter((e) => {
    if (e.type === "payment.signed" && e.receipt && settled.has(e.receipt.id)) return false;
    if ((e.type === "payment.needs_approval" || e.type === "service.requested") && approvalIdOf(e) && decided.has(approvalIdOf(e)!)) return false;
    if (e.type === "approval.approved" && isServiceApproval(e.approval) && connectKey(e) && connected.has(connectKey(e)!)) return false;
    // §6: a policy freeze comes as a pair (payment.blocked + agent.frozen) sharing receiptId; the
    // blocked row already says "Agent frozen.", and the banner + red card carry the frozen state.
    if (e.type === "agent.frozen" && frozenReceiptId(e) && blocked.has(frozenReceiptId(e)!)) return false;
    return true;
  });
}

function withService(agent: AgentPublic, svc: ConnectedService): AgentPublic {
  const services = agent.services ?? [];
  const idx = services.findIndex((s) => s.id === svc.id);
  const next = idx >= 0 ? services.map((s, i) => (i === idx ? { ...s, ...svc } : s)) : [...services, svc];
  return { ...agent, services: next };
}

/** The connection a `service.connected` event describes, filled in from the event when fields are missing. */
export function connectionFromEvent(e: WalletEvent): ConnectedService | undefined {
  const svc = serviceOfEvent(e);
  if (!svc?.id) return undefined;
  const data = (e.data ?? {}) as { connectedBy?: ConnectedService["connectedBy"] };
  const s = svc as Partial<ConnectedService>;
  return {
    icon: "🔌",
    color: "#5B7CFA",
    provider: "",
    kind: "x402",
    summary: "",
    baseUrl: "",
    pricing: "",
    maxPrice: "0.00",
    permissions: [],
    name: svc.name ?? svc.id,
    ...s,
    id: svc.id,
    connectedAt: s.connectedAt ?? e.at,
    connectedBy: s.connectedBy ?? data.connectedBy ?? (e.approval ? "approval" : "owner"),
  } as ConnectedService;
}

/**
 * `bank.posted` / `bank.failed` (§16.3) are not feed rows: they update the marker of the receipt
 * they carry, in the receipts list and on every feed row showing that receipt.
 */
function applyBankEvent(state: DashboardState, e: WalletEvent): DashboardState {
  const b = bankFromEvent(e);
  if (!b) return state;
  const known = state.receipts.find((r) => r.id === b.receiptId);
  const receipts = e.receipt ? upsertReceipt(state.receipts, { ...e.receipt, bank: b.bank }) : known ? upsertReceipt(state.receipts, { ...known, bank: b.bank }) : state.receipts;
  return { ...state, receipts, events: patchReceiptBank(state.events, b.receiptId, b.bank) };
}

/** Apply one wallet event to the state. Idempotent on event id. */
export function applyEvent(state: DashboardState, e: WalletEvent): DashboardState {
  if (isBankEvent(e.type)) return applyBankEvent(state, e);
  if (state.events.some((x) => x.id === e.id)) return state;
  let next: DashboardState = { ...state, events: collapseFeed([e, ...state.events]).slice(0, MAX_FEED) };

  if (e.receipt) next.receipts = upsertReceipt(next.receipts, e.receipt);

  switch (e.type) {
    case "agent.frozen":
      next.agents = next.agents.map((a) =>
        a.id === e.agentId
          ? { ...a, frozen: true, frozenReason: e.reason ?? e.message, policy: { ...a.policy, frozen: true } }
          : a,
      );
      break;
    case "agent.unfrozen":
      next.agents = next.agents.map((a) =>
        a.id === e.agentId ? { ...a, frozen: false, frozenReason: undefined, policy: { ...a.policy, frozen: false } } : a,
      );
      break;
    case "agent.created": {
      const agent = (e.data as { agent?: AgentPublic } | undefined)?.agent;
      if (agent) next.agents = upsertAgent(next.agents, agent);
      break;
    }
    case "policy.updated": {
      const data = e.data as { agent?: AgentPublic; policy?: AgentPublic["policy"] } | undefined;
      if (data?.agent) next.agents = upsertAgent(next.agents, data.agent);
      else if (data?.policy) next.agents = patchAgent(next.agents, e.agentId, { policy: data.policy });
      break;
    }
    case "payment.needs_approval":
    case "service.requested":
      if (e.approval && e.approval.status !== "approved" && e.approval.status !== "denied" && e.approval.status !== "expired" && !next.approvals.some((a) => a.id === e.approval!.id)) {
        const approval: Approval = e.type === "service.requested" && !e.approval.kind ? { ...e.approval, kind: "service" } : e.approval;
        next.approvals = sortNewest([approval, ...next.approvals]);
      }
      break;
    case "service.connected": {
      const svc = connectionFromEvent(e);
      if (svc && e.agentId) next.agents = next.agents.map((a) => (a.id === e.agentId ? withService(a, svc) : a));
      break;
    }
    case "service.disconnected": {
      const sid = serviceIdOfEvent(e);
      if (sid && e.agentId) {
        next.agents = next.agents.map((a) => (a.id === e.agentId ? { ...a, services: (a.services ?? []).filter((s) => s.id !== sid) } : a));
      }
      break;
    }
    case "approval.approved":
    case "approval.denied": {
      const id = e.approval?.id ?? e.receipt?.approvalId;
      if (id) next.approvals = next.approvals.filter((a) => a.id !== id);
      break;
    }
    case "topup":
      if (e.receipt && e.agentId) {
        const agent = next.agents.find((a) => a.id === e.agentId);
        if (agent) {
          const bal = (Number(agent.balance) + Number(e.receipt.amount)).toFixed(2);
          next.agents = patchAgent(next.agents, e.agentId, { balance: bal });
        }
      }
      break;
    default:
      break;
  }
  return next;
}

export function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        loaded: true,
        agents: normAll(action.summary.agents),
        totals: totalsFrom(action.summary),
        approvals: sortNewest(action.approvals.filter((a) => a.status === "pending")),
        receipts: sortNewest(action.receipts).slice(0, MAX_RECEIPTS),
        events: collapseFeed(foldBankEvents(sortNewestEvents(action.events), action.receipts)).slice(0, MAX_FEED),
        lastError: undefined,
      };
    case "summary":
      return { ...state, agents: normAll(action.summary.agents), totals: totalsFrom(action.summary), approvals: sortNewest(action.summary.pendingApprovals) };
    case "receipts":
      return { ...state, receipts: sortNewest(action.receipts).slice(0, MAX_RECEIPTS) };
    case "approvals":
      return { ...state, approvals: sortNewest(action.approvals.filter((a) => a.status === "pending")) };
    case "event":
      return applyEvent(state, action.event);
    case "agent":
      return { ...state, agents: upsertAgent(state.agents, action.agent) };
    case "connection":
      return { ...state, connection: action.status, offlineFallback: action.offlineFallback ?? state.offlineFallback };
    case "toggleDetails":
      return { ...state, showDetails: !state.showDetails };
    case "busyApproval":
      return { ...state, busyApprovals: toggleId(state.busyApprovals, action.id, action.busy) };
    case "busyAgent":
      return { ...state, busyAgents: toggleId(state.busyAgents, action.id, action.busy) };
    case "busyService":
      return { ...state, busyServices: toggleId(state.busyServices, action.key, action.busy) };
    case "directoryLoading":
      return { ...state, directoryStatus: state.directoryStatus === "ready" ? "ready" : "loading" };
    case "directory":
      return { ...state, directory: action.services, directoryStatus: "ready", directoryError: undefined };
    case "directoryUpsert": {
      const idx = state.directory.findIndex((s) => s.id === action.service.id);
      const directory = idx >= 0 ? state.directory.map((s, i) => (i === idx ? { ...s, ...action.service } : s)) : [...state.directory, action.service];
      return { ...state, directory, directoryStatus: "ready" };
    }
    case "directoryError":
      // Keep a catalog we already have; only show the error when there is nothing to show.
      return { ...state, directoryStatus: state.directory.length ? "ready" : "error", directoryError: action.message };
    case "serviceDocs":
      return { ...state, serviceDocs: { ...state.serviceDocs, [action.id]: action.docs } };
    case "bank":
      return { ...state, bank: action.bank };
    case "bankRetried": {
      let events = state.events;
      let moved = 0;
      const receipts = state.receipts.map((r) => {
        if (r.bank?.status !== "failed" || (action.receiptId && r.id !== action.receiptId)) return r;
        moved++;
        const bank = { status: "queued" as const, account: r.bank.account };
        events = patchReceiptBank(events, r.id, bank);
        return { ...r, bank };
      });
      const q = state.bank?.queue;
      const n = action.receiptId ? Math.min(moved, q?.failed ?? 0) : (q?.failed ?? 0);
      const bank = state.bank && q ? { ...state.bank, queue: { pending: q.pending + n, failed: q.failed - n } } : state.bank;
      return { ...state, receipts, events, bank };
    }
    case "error":
      return { ...state, lastError: action.message };
  }
}

function toggleId(ids: string[], id: string, on: boolean): string[] {
  return on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id);
}

function sortNewestEvents(events: WalletEvent[]): WalletEvent[] {
  return [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** Selectors */
export function frozenAgents(state: DashboardState): AgentPublic[] {
  return state.agents.filter((a) => a.frozen);
}
