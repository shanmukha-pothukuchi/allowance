/**
 * Data adapter contract. The UI only ever talks to one of these. Two implementations:
 *  - httpAdapter: the real wallet-service (fetch + EventSource on /v1/events)
 *  - mockAdapter: in-memory, generates a believable live stream
 * The mock is used only on explicit request (?mock=1 in the URL or VITE_MOCK=1); otherwise HTTP,
 * and an unreachable wallet-service shows "offline" (never a silent fallback, §12).
 */
import type {
  AddServiceRequest,
  AddServiceResponse,
  AddShopifyStoreRequest,
  AgentPublic,
  Approval,
  BankStatementResponse,
  BankSummary,
  ConnectionStatus,
  CreateAgentRequest,
  CreateAgentResponse,
  DirectoryService,
  Receipt,
  ServicePreview,
  ShopifyStore,
  SummaryResponse,
  WalletEvent,
} from "../types";
import type { AgentRules, Portfolios, SchedulerState } from "../invest";

/** A failed wallet call: HTTP status plus the contract's `error` code (both adapters throw these). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

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
  /** `POST /v1/agents` (§14.2). The response's token is shown once and never stored. */
  createAgent(req: CreateAgentRequest): Promise<CreateAgentResponse>;
  /** The service directory (§13.2 owner view: no docs, plus `connectedAgents`). */
  getDirectory(q?: string): Promise<DirectoryService[]>;
  /** One directory entry with its usage docs. */
  getService(serviceId: string): Promise<DirectoryService>;
  /** Owner connects a directory service to an agent directly (`connectedBy: "owner"`). */
  connectService(agentId: string, serviceId: string): Promise<AgentPublic>;
  disconnectService(agentId: string, serviceId: string): Promise<AgentPublic>;
  /** `GET /v1/directory/shopify/preview?url=` (§15.3): what the bridge sees at that link. No side effects. */
  previewShopifyStore(url: string): Promise<ShopifyStore>;
  /** `POST /v1/directory/shopify` (§15.3): add the store to the directory, optionally connecting agents. */
  addShopifyStore(req: AddShopifyStoreRequest): Promise<{ service: DirectoryService; agents?: AgentPublic[] }>;
  /** `GET /v1/directory/preview?url=` (§18): what a pasted link is (directory, Shopify store, x402 API). No side effects. */
  previewService(url: string): Promise<ServicePreview>;
  /** `POST /v1/directory/add` (§18): connect (and for a store, list) what the link resolved to. */
  addService(req: AddServiceRequest): Promise<AddServiceResponse>;
  /**
   * Capital One (Nessie sandbox, §16.4). Called only when the summary carries `bank`, so a wallet
   * without a Nessie key is never asked.
   */
  getBank(): Promise<BankSummary>;
  /** One agent's allowance account statement (`agentId`), or checking's (none). Newest first. */
  getBankStatement(agentId?: string, limit?: number): Promise<BankStatementResponse>;
  /** `POST /v1/bank/retry { receiptId? }`: re-queue that receipt, or every entry that didn't reach the statement. */
  retryBank(receiptId?: string): Promise<{ queued: number }>;
  /** `POST /v1/bank/link` (idempotent): create the owner and checking at Nessie. */
  linkBank(): Promise<BankSummary>;
  /**
   * §20.2: move USDC from the agent back to the owner (to checking, when Capital One is linked).
   * `"all"` empties the wallet. Works even while the agent is frozen.
   */
  cashout(agentId: string, amount: string | "all"): Promise<Receipt>;
  /** §20.1, owner view: every agent's paper portfolio, and the replay clock. */
  getPortfolios(): Promise<Portfolios>;
  /** §20.3, owner view: every schedule, recent firings, and whether autonomy is paused. */
  getScheduler(): Promise<SchedulerState>;
  /** Cancel any schedule (the agent's own, or an owner rule). */
  cancelSchedule(id: string): Promise<void>;
  /** Replace one agent's owner rules (take profit, stop loss, cash out profits above). Empty fields turn a rule off. */
  setRules(agent: Pick<AgentPublic, "id" | "name">, rules: AgentRules): Promise<void>;
  /** The autonomy switch: `true` pauses every schedule, `false` resumes. Answers the new state. */
  setPaused(paused: boolean): Promise<boolean>;
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
