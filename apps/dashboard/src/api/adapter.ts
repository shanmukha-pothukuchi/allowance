/**
 * Data adapter contract. The UI only ever talks to one of these. Two implementations:
 *  - httpAdapter: the real wallet-service (fetch + EventSource on /v1/events)
 *  - mockAdapter: in-memory, generates a believable live stream
 * The mock is used only on explicit request (?mock=1 in the URL or VITE_MOCK=1); otherwise HTTP,
 * and an unreachable wallet-service shows "offline" (never a silent fallback, §12).
 */
import type { AgentPublic, Approval, ConnectionStatus, DirectoryService, Receipt, SummaryResponse, WalletEvent } from "../types";

export interface WalletAdapter {
  readonly kind: "http" | "mock";
  getSummary(): Promise<SummaryResponse>;
  getAgents(): Promise<AgentPublic[]>;
  getReceipts(limit?: number): Promise<Receipt[]>;
  getRecentEvents(limit?: number): Promise<WalletEvent[]>;
  getPendingApprovals(): Promise<Approval[]>;
  /** One approval by id, in any status (for the embed). `null` when unknown. */
  getApproval(id: string): Promise<Approval | null>;
  /** Approve or deny any approval (payment or service). */
  approve(id: string): Promise<Approval>;
  deny(id: string): Promise<Approval>;
  freeze(agentId: string): Promise<AgentPublic>;
  unfreeze(agentId: string): Promise<AgentPublic>;
  topup(agentId: string, amount: string): Promise<Receipt>;
  /** The service directory (§13.2 owner view: no docs, plus `connectedAgents`). */
  getDirectory(q?: string): Promise<DirectoryService[]>;
  /** One directory entry with its usage docs. */
  getService(serviceId: string): Promise<DirectoryService>;
  /** Owner connects a directory service to an agent directly (`connectedBy: "owner"`). */
  connectService(agentId: string, serviceId: string): Promise<AgentPublic>;
  disconnectService(agentId: string, serviceId: string): Promise<AgentPublic>;
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

/** `?approval=<id>&embed=1` → the approval id to render alone (§13.5), else null. */
export function embedApprovalId(search: string = typeof location !== "undefined" ? location.search : ""): string | null {
  const params = new URLSearchParams(search);
  const id = params.get("approval");
  const embed = params.get("embed");
  return id && (embed === "1" || embed === "true") ? id : null;
}
