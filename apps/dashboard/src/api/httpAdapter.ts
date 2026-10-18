import { normPortfolios, normScheduler } from "../invest";
import { unwrapAdded, unwrapStore } from "../shopify";
import type {
  AddServiceResponse,
  AgentPublic,
  Approval,
  BankStatementResponse,
  BankSummary,
  CreateAgentResponse,
  DirectoryService,
  Receipt,
  ServicePreview,
  SummaryResponse,
  WalletEvent,
} from "../types";
import { EVENT_TYPES } from "../types";
import { HttpError, type WalletAdapter } from "./adapter";

export { HttpError };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
      code = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError(message, res.status, code);
  }
  // DELETE /schedules/:id and friends may answer 204 with no body.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const enc = encodeURIComponent;

/** One approval in any status: `GET /v1/approvals` without `status` lists them all (§6). */
async function findApproval(id: string): Promise<Approval | null> {
  const { approvals } = await req<{ approvals: Approval[] }>("/v1/approvals");
  return approvals.find((x) => x.id === id) ?? null;
}

/** True if the wallet-service answers /v1/health within `timeoutMs`. */
export async function walletServiceReachable(timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/v1/health", { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpAdapter(): WalletAdapter {
  return {
    kind: "http",
    getSummary: () => req<SummaryResponse>("/v1/summary"),
    getAgents: async () => (await req<{ agents: AgentPublic[] }>("/v1/agents")).agents,
    getReceipts: async (limit = 50) => (await req<{ receipts: Receipt[] }>(`/v1/receipts?limit=${limit}`)).receipts,
    getRecentEvents: async (limit = 100) => (await req<{ events: WalletEvent[] }>(`/v1/events/recent?limit=${limit}`)).events,
    getPendingApprovals: async () => (await req<{ approvals: Approval[] }>("/v1/approvals?status=pending")).approvals,
    getApproval: findApproval,
    approve: async (id) => (await post<{ approval: Approval }>(`/v1/approvals/${encodeURIComponent(id)}/approve`, { by: "dashboard" })).approval,
    deny: async (id) => (await post<{ approval: Approval }>(`/v1/approvals/${encodeURIComponent(id)}/deny`, { by: "dashboard" })).approval,
    freeze: async (agentId) => (await post<{ agent: AgentPublic }>(`/v1/agents/${encodeURIComponent(agentId)}/freeze`)).agent,
    unfreeze: async (agentId) => (await post<{ agent: AgentPublic }>(`/v1/agents/${encodeURIComponent(agentId)}/unfreeze`)).agent,
    topup: async (agentId, amount) => (await post<{ receipt: Receipt }>(`/v1/agents/${encodeURIComponent(agentId)}/topup`, { amount })).receipt,
    createAgent: (body) => post<CreateAgentResponse>("/v1/agents", body),
    getDirectory: async (q) => (await req<{ services: DirectoryService[] }>(`/v1/directory${q ? `?q=${enc(q)}` : ""}`)).services,
    getService: async (serviceId) => {
      const body = await req<DirectoryService | { service: DirectoryService }>(`/v1/directory/${enc(serviceId)}`);
      return "service" in body ? body.service : body;
    },
    connectService: async (agentId, serviceId) => (await post<{ agent: AgentPublic }>(`/v1/agents/${enc(agentId)}/services`, { serviceId })).agent,
    disconnectService: async (agentId, serviceId) =>
      (await req<{ agent: AgentPublic }>(`/v1/agents/${enc(agentId)}/services/${enc(serviceId)}`, { method: "DELETE" })).agent,
    previewShopifyStore: async (url) => unwrapStore(await req<unknown>(`/v1/directory/shopify/preview?url=${enc(url)}`)),
    addShopifyStore: async (body) => {
      const out = unwrapAdded(await post<unknown>("/v1/directory/shopify", body));
      return { service: out.service, ...(out.agents ? { agents: out.agents as AgentPublic[] } : {}) };
    },
    previewService: (url) => req<ServicePreview>(`/v1/directory/preview?url=${enc(url)}`),
    addService: (body) => post<AddServiceResponse>("/v1/directory/add", body),
    getBank: () => req<BankSummary>("/v1/bank"),
    getBankStatement: (agentId, limit = 50) => req<BankStatementResponse>(`/v1/bank/statement?${agentId ? `agentId=${enc(agentId)}&` : ""}limit=${limit}`),
    retryBank: (receiptId) => post<{ queued: number }>("/v1/bank/retry", receiptId ? { receiptId } : {}),
    linkBank: () => post<BankSummary>("/v1/bank/link"),
    // §20.2: `{ status: "sent", receipt, vault, balance }`.
    cashout: async (agentId, amount) => {
      const body = await post<{ receipt?: Receipt } & Partial<Receipt>>(`/v1/agents/${enc(agentId)}/cashout`, { amount });
      return (body?.receipt ?? body) as Receipt;
    },
    // §20.1/§20.3 behind the dashboard's own proxy (vite.config.ts): /brokerage → :4110, /scheduler → :4100,
    // with the owner key added server-side for this page's own requests only.
    // `{ mode, clockDate, startDate, label, portfolios: [{ address, positions, totals, orders }] }`, by wallet address.
    getPortfolios: async () => normPortfolios(await req<unknown>("/brokerage/portfolios")),
    // Owner view: `{ schedules, paused, pausedAt, limits, firingsToday, firings }`; `all=1` keeps ended ones (the Done group).
    getScheduler: async () => normScheduler(await req<unknown>("/scheduler/schedules?all=1")),
    cancelSchedule: async (id) => {
      await req<unknown>(`/scheduler/schedules/${enc(id)}`, { method: "DELETE" });
    },
    setRules: async (agent, rules) => {
      await post<unknown>("/scheduler/rules", { agentName: agent.name, agentId: agent.id, ...rules });
    },
    setPaused: async (paused) => {
      const body = await post<{ paused?: boolean } | undefined>(paused ? "/scheduler/pause" : "/scheduler/resume");
      return typeof body?.paused === "boolean" ? body.paused : paused;
    },
    subscribe(onEvent, onStatus) {
      // EventSource reconnects on its own; we only surface the status. Named events
      // (`event: payment.signed`) do not fire `onmessage`, so listen to each type.
      const es = new EventSource("/v1/events");
      onStatus?.("connecting");
      const handle = (ev: MessageEvent) => {
        try {
          onEvent(JSON.parse(ev.data) as WalletEvent);
        } catch (err) {
          console.warn("[dashboard] bad SSE payload", err);
        }
      };
      for (const t of EVENT_TYPES) es.addEventListener(t, handle as EventListener);
      es.onmessage = handle; // in case the server ever sends unnamed events
      es.onopen = () => onStatus?.("live");
      es.onerror = () => onStatus?.("reconnecting");
      return () => es.close();
    },
  };
}
