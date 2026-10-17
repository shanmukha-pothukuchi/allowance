/**
 * Data adapter contract. The UI only ever talks to one of these. Two implementations:
 *  - httpAdapter: the real wallet-service (fetch + EventSource on /v1/events)
 *  - mockAdapter: in-memory, generates a believable live stream
 * Pick with ?mock=1 in the URL or VITE_MOCK=1; otherwise HTTP, falling back to mock
 * when the wallet-service health check fails.
 */
import type { AgentPublic, Approval, ConnectionStatus, Receipt, SummaryResponse, WalletEvent } from "../types";

export interface WalletAdapter {
  readonly kind: "http" | "mock";
  getSummary(): Promise<SummaryResponse>;
  getAgents(): Promise<AgentPublic[]>;
  getReceipts(limit?: number): Promise<Receipt[]>;
  getRecentEvents(limit?: number): Promise<WalletEvent[]>;
  getPendingApprovals(): Promise<Approval[]>;
  approve(id: string): Promise<Approval>;
  deny(id: string): Promise<Approval>;
  freeze(agentId: string): Promise<AgentPublic>;
  unfreeze(agentId: string): Promise<AgentPublic>;
  topup(agentId: string, amount: string): Promise<Receipt>;
  /** Live events. Returns an unsubscribe function. `onStatus` reports stream health. */
  subscribe(onEvent: (e: WalletEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void;
}

export function mockRequested(search: string = typeof location !== "undefined" ? location.search : "", env: Record<string, unknown> = import.meta.env ?? {}): boolean {
  const params = new URLSearchParams(search);
  const q = params.get("mock");
  if (q === "1" || q === "true") return true;
  if (q === "0" || q === "false") return false;
  return env.VITE_MOCK === "1" || env.VITE_MOCK === "true";
}
