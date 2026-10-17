import type { AgentPublic, Approval, Receipt, SummaryResponse, WalletEvent } from "../types";
import { EVENT_TYPES } from "../types";
import type { WalletAdapter } from "./adapter";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

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
    approve: async (id) => (await post<{ approval: Approval }>(`/v1/approvals/${encodeURIComponent(id)}/approve`, { by: "dashboard" })).approval,
    deny: async (id) => (await post<{ approval: Approval }>(`/v1/approvals/${encodeURIComponent(id)}/deny`, { by: "dashboard" })).approval,
    freeze: async (agentId) => (await post<{ agent: AgentPublic }>(`/v1/agents/${encodeURIComponent(agentId)}/freeze`)).agent,
    unfreeze: async (agentId) => (await post<{ agent: AgentPublic }>(`/v1/agents/${encodeURIComponent(agentId)}/unfreeze`)).agent,
    topup: async (agentId, amount) => (await post<{ receipt: Receipt }>(`/v1/agents/${encodeURIComponent(agentId)}/topup`, { amount })).receipt,
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
