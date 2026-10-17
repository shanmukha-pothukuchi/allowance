/**
 * Pure state + reducer for the dashboard. The hook feeds it the initial fetches and
 * then every SSE event; components only read from it. Unit-tested in state.test.ts.
 */
import type {
  AgentPublic,
  Approval,
  ConnectionStatus,
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
  loaded: boolean;
  lastError?: string;
}

export const initialState: DashboardState = {
  agents: [],
  totals: { totalBalance: "0.00", spentToday: "0.00", earnedToday: "0.00", chainMode: "unknown", telegramConnected: false },
  events: [],
  receipts: [],
  approvals: [],
  connection: "connecting",
  offlineFallback: false,
  showDetails: false,
  busyApprovals: [],
  busyAgents: [],
  loaded: false,
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
  | { type: "error"; message?: string };

const MONEY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "payment.signed",
  "payment.settled",
  "payment.blocked",
  "approval.approved",
  "transfer.sent",
  "earning.received",
  "topup",
]);

/** Events after which balances / spent today may have changed and the summary should be refetched. */
export function isMoneyEvent(type: EventType): boolean {
  return MONEY_EVENTS.has(type);
}

function totalsFrom(summary: SummaryResponse): Totals {
  return {
    totalBalance: summary.totalBalance,
    spentToday: summary.spentToday,
    earnedToday: summary.earnedToday,
    chainMode: summary.chainMode,
    telegramConnected: summary.telegramConnected,
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

function upsertAgent(agents: AgentPublic[], agent: AgentPublic): AgentPublic[] {
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

/** Apply one wallet event to the state. Idempotent on event id. */
export function applyEvent(state: DashboardState, e: WalletEvent): DashboardState {
  if (state.events.some((x) => x.id === e.id)) return state;
  // A settlement supersedes its own "is paying" row so the feed shows one line per payment.
  const superseded = e.type === "payment.settled" && e.receipt ? e.receipt.id : undefined;
  const kept = superseded
    ? state.events.filter((x) => !(x.type === "payment.signed" && x.receipt?.id === superseded))
    : state.events;
  let next: DashboardState = { ...state, events: [e, ...kept].slice(0, MAX_FEED) };

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
      if (e.approval && !next.approvals.some((a) => a.id === e.approval!.id)) {
        next.approvals = sortNewest([e.approval, ...next.approvals]);
      }
      break;
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
        agents: action.summary.agents,
        totals: totalsFrom(action.summary),
        approvals: sortNewest(action.approvals.filter((a) => a.status === "pending")),
        receipts: sortNewest(action.receipts).slice(0, MAX_RECEIPTS),
        events: sortNewestEvents(action.events).slice(0, MAX_FEED),
        lastError: undefined,
      };
    case "summary":
      return { ...state, agents: action.summary.agents, totals: totalsFrom(action.summary), approvals: sortNewest(action.summary.pendingApprovals) };
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
