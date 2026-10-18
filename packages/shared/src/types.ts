/**
 * Shared contracts for Allowance. These are the Phase 0 source of truth.
 * All amounts crossing an API boundary are decimal USD strings ("18.50") unless the
 * field name ends in `BaseUnits` ("18500000", USDC 6 decimals). USDC == USD for display.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type IsoDate = string;

// ----------------------------------------------------------------------------
// Policy
// ----------------------------------------------------------------------------

export interface Policy {
  /** Max dollars per single payment/transfer, e.g. "5.00". */
  maxPerTx: string;
  /** Max dollars spent per local calendar day (resets local midnight), e.g. "25.00". */
  dailyCap: string;
  /**
   * Recipient allowlist. A spend is allowed if the recipient address is in `addresses`
   * OR the merchant origin (scheme://host:port of the paid URL) is in `origins`.
   * `null` = no allowlist restriction. Empty arrays = nothing is allowed.
   * Direct transfers have no origin, so they must match `addresses`.
   */
  allowlist: { addresses: Address[]; origins: string[] } | null;
  /** Payments strictly above this need owner approval, e.g. "10.00". "0" = everything needs approval. */
  approvalThreshold: string;
  /** Frozen agents cannot spend at all. */
  frozen: boolean;
  /** When a rule is violated, freeze the agent automatically (default true). */
  freezeOnViolation: boolean;
}

export const DEFAULT_POLICY: Policy = {
  maxPerTx: "5.00",
  dailyCap: "25.00",
  allowlist: null,
  approvalThreshold: "10.00",
  frozen: false,
  freezeOnViolation: true,
};

export type PolicyBlockReason =
  | "frozen"
  | "max_per_tx"
  | "daily_cap"
  | "not_allowlisted"
  | "insufficient_balance"
  /** The 402 offered no USDC-on-Base-Sepolia option. Blocks without freezing; no receipt. */
  | "unsupported_requirements"
  /** The URL belongs to a directory service the agent has not connected. Soft block: no freeze; ask the owner. */
  | "service_not_connected"
  /** Over the per-payment cap of the connected service it was paid through. */
  | "service_cap";

export type PolicyDecision =
  | { outcome: "allow" }
  | { outcome: "needs_approval"; reason: "over_approval_threshold" }
  | { outcome: "block"; reason: PolicyBlockReason; message: string };

/** What the policy engine is asked to evaluate. */
export interface SpendRequest {
  amountBaseUnits: bigint;
  to: Address;
  /** scheme://host[:port] of the paid resource, if this is an x402 payment. */
  origin?: string;
  /** Full URL of the paid resource (x402 only). Matched against connected-service base URLs. */
  url?: string;
}

// ----------------------------------------------------------------------------
// Agents, tokens
// ----------------------------------------------------------------------------

export interface AgentPublic {
  id: string;
  name: string;
  address: Address;
  policy: Policy;
  /** Connected services (the directory itself is always available and not listed). */
  services: ConnectedService[];
  createdAt: IsoDate;
  /** Balance in dollars, from the active ledger (mock or chain). */
  balance: string;
  spentToday: string;
  earnedToday: string;
  frozen: boolean;
  /** Why it was frozen, if auto-frozen. */
  frozenReason?: string;
}

export interface AgentToken {
  id: string;
  agentId: string;
  /** Last 4 chars of the token, for display only. */
  hint: string;
  createdAt: IsoDate;
  revokedAt?: IsoDate;
}

// ----------------------------------------------------------------------------
// Receipts
// ----------------------------------------------------------------------------

export type ReceiptKind = "spend" | "earn" | "transfer" | "topup";
export type ReceiptStatus = "pending_approval" | "signed" | "settled" | "failed" | "denied" | "blocked";

export interface Receipt {
  id: string;
  kind: ReceiptKind;
  status: ReceiptStatus;
  agentId: string;
  agentName: string;
  /** Human description: "Acme Weather", "Bounty: API reliability check", "Transfer". */
  description: string;
  amount: string;
  amountBaseUnits: string;
  counterparty: { address: Address; origin?: string; name?: string };
  network: string;
  txHash?: Hex;
  explorerUrl?: string;
  createdAt: IsoDate;
  settledAt?: IsoDate;
  /** Linked payment / approval ids, when relevant. */
  paymentId?: string;
  approvalId?: string;
  /** For blocked/denied receipts: why. */
  reason?: string;
}

// ----------------------------------------------------------------------------
// Approvals
// ----------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
  id: string;
  /** "payment" (default when absent) or "service" (connect a service to this agent). */
  kind?: "payment" | "service";
  agentId: string;
  agentName: string;
  /** Payment approvals only ("" for service approvals). */
  paymentId: string;
  /** Payment amount; for service approvals the service's per-payment cap ("0.00" if free). */
  amount: string;
  description: string;
  counterparty: { address: Address; origin?: string; name?: string };
  /** Service approvals only: what will be connected. */
  service?: ServiceGrant;
  /** Service approvals only: why the agent asked (its own words, untrusted). */
  reason?: string;
  status: ApprovalStatus;
  createdAt: IsoDate;
  decidedAt?: IsoDate;
  /** "telegram" | "dashboard" | "auto" */
  decidedBy?: string;
}

// ----------------------------------------------------------------------------
// Services (see docs/ARCHITECTURE.md §13)
// ----------------------------------------------------------------------------

export type ServiceKind = "x402" | "agent-work" | "directory";
export type ServiceCategory = "data" | "shopping" | "work" | "tools";

/** A service as listed in the directory. */
export interface ServiceManifest {
  /** Stable id, e.g. "acme-pizza". */
  id: string;
  name: string;
  provider: string;
  /** Single emoji used as the app icon. */
  icon: string;
  /** Hex color for the icon tile. */
  color: string;
  category: ServiceCategory;
  kind: ServiceKind;
  /** One line. This is what agents see in their context, like a skill description. */
  summary: string;
  /** A few sentences for humans (directory / dashboard). */
  description: string;
  /** URL prefix the agent may pay once connected, e.g. "http://localhost:4021/pizza". */
  baseUrl: string;
  /** Human pricing, e.g. "$18.50 per order". "Free" for free services. */
  pricing: string;
  /** Largest single payment this service needs, dollars ("0.00" if free). Becomes the connection's cap. */
  maxPrice: string;
  /** Human-readable grants shown on the approval card. */
  permissions: string[];
  /** Usage docs loaded on demand (like SKILL.md): endpoints, parameters, examples. Plain text. */
  docs: string;
  /** "directory" for catalog entries, "agent" for custom services an agent proposed and the owner approved. */
  source?: "directory" | "agent";
  /** Shopify stores only (see docs/ARCHITECTURE.md §15). */
  shopify?: ShopifyStoreRef;
}

/** How agents can buy from a Shopify store through the bridge. */
export type ShopifyMode =
  /** The owner's own store with Admin API credentials: the agent pays in USDC (x402) and the bridge creates a paid order. */
  | "agent_checkout"
  /** Any other store: browse and build a cart; the owner finishes payment at Shopify's checkout link. */
  | "handoff";

export interface ShopifyStoreRef {
  /** Subdomain of *.myshopify.com, e.g. "crypto-app-test". */
  handle: string;
  /** e.g. "crypto-app-test.myshopify.com" */
  domain: string;
  mode: ShopifyMode;
}

/** A store the bridge knows about. */
export interface ShopifyStore extends ShopifyStoreRef {
  name: string;
  currency: string;
  /** Rough catalog size at discovery time, if known. */
  productCount?: number;
  addedAt?: IsoDate;
}

/** Shown on approval cards and stored on the connection. */
export type ServiceGrant = Pick<ServiceManifest, "id" | "name" | "provider" | "icon" | "color" | "kind" | "summary" | "baseUrl" | "pricing" | "maxPrice" | "permissions" | "source" | "shopify"> & {
  /** Directory category; custom (agent-proposed) services default to "tools". */
  category?: ServiceCategory;
};

/** A service connected to one agent. */
export interface ConnectedService extends ServiceGrant {
  connectedAt: IsoDate;
  /** "owner" (connected from the dashboard), "approval" (owner approved an agent's request), "default" (setup). */
  connectedBy: "owner" | "approval" | "default";
  /** Custom services only: docs the agent wrote when proposing it. */
  docs?: string;
}

/** POST /v1/services/requests (agent token). Either a directory id or a custom proposal. */
export interface ServiceRequest {
  serviceId?: string;
  /** Custom service not in the directory (Muse-style "write a connector"). Owner sees it flagged as agent-proposed. */
  custom?: { name: string; baseUrl: string; summary: string; maxPrice: string; docs?: string };
  /** A Shopify store to add (e.g. "https://crypto-app-test.myshopify.com"); discovered via the bridge. */
  shopifyStoreUrl?: string;
  /** Shopify only: per-order cap the agent asks for (dollars). Defaults to the agent's max per payment. */
  maxPrice?: string;
  /** The agent's reason, shown to the owner verbatim (untrusted). */
  reason?: string;
}

export type ServiceRequestResponse =
  | { status: "connected"; service: ConnectedService }
  | { status: "needs_approval"; approvalId: string; service: ServiceGrant; message: string };

// ----------------------------------------------------------------------------
// Events (SSE stream from wallet-service)
// ----------------------------------------------------------------------------

export type EventType =
  | "agent.created"
  | "agent.frozen"
  | "agent.unfrozen"
  | "policy.updated"
  | "token.revoked"
  | "payment.signed"
  | "payment.settled"
  | "payment.needs_approval"
  | "payment.blocked"
  | "approval.approved"
  | "approval.denied"
  | "transfer.sent"
  | "earning.received"
  | "topup"
  | "service.requested"
  | "service.connected"
  | "service.disconnected";

export interface WalletEvent {
  id: string;
  type: EventType;
  at: IsoDate;
  agentId?: string;
  agentName?: string;
  /** One-line human summary, dollars only. "Paid $0.05 to Acme Weather." */
  message: string;
  receipt?: Receipt;
  approval?: Approval;
  reason?: string;
  data?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// x402 wire types (mirror @x402/core v2; duplicated here so shared has no deps)
// ----------------------------------------------------------------------------

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string; serviceName?: string };
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface X402SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
}

// ----------------------------------------------------------------------------
// Wallet-service API request/response shapes
// ----------------------------------------------------------------------------

/** POST /v1/pay (agent token) */
export interface PayRequest {
  /** The decoded PAYMENT-REQUIRED header from the 402. */
  paymentRequired: X402PaymentRequired;
  /** The URL that returned 402 (used for origin allowlisting and the receipt). */
  url: string;
  /** Optional friendly name for the receipt ("Acme Weather"). */
  description?: string;
  /** Optional: the original request, echoed back by /wait so a restarted agent can resume. */
  method?: "GET" | "POST";
  body?: unknown;
}

/** Echo of the original request, returned by /v1/approvals/:id/wait for approved x402 payments. */
export interface OriginalRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
}

export type PayResponse =
  | {
      status: "approved";
      paymentId: string;
      /** Value for the PAYMENT-SIGNATURE header (base64 PaymentPayload). */
      paymentHeader: string;
      receipt: Receipt;
    }
  | {
      status: "needs_approval";
      paymentId: string;
      approvalId: string;
      amount: string;
      message: string;
      receipt: Receipt;
    }
  | {
      status: "blocked";
      reason: PolicyBlockReason;
      message: string;
      frozen: boolean;
      receipt: Receipt;
      /** service_not_connected only: which directory service the URL belongs to. */
      service?: { id: string; name: string; icon: string };
      serviceId?: string;
    };

/** POST /v1/payments/:paymentId/settled (agent token) — report the PAYMENT-RESPONSE. */
export interface SettledRequest {
  settleResponse: X402SettleResponse;
}

/** POST /v1/transfer (agent token) — direct USDC transfer, same policy path. */
export interface TransferRequest {
  to: Address;
  amount: string;
  memo?: string;
}

export type TransferResponse =
  | { status: "sent"; receipt: Receipt }
  | { status: "needs_approval"; approvalId: string; amount: string; message: string; receipt: Receipt }
  | { status: "blocked"; reason: PolicyBlockReason; message: string; frozen: boolean; receipt: Receipt };

/** GET /v1/approvals/:id/wait?timeoutMs=45000 (agent token) */
export type ApprovalWaitResponse =
  | { status: "pending"; approvalId: string; kind: "payment" | "service"; service?: ServiceGrant }
  | { status: "denied"; approvalId: string; kind: "payment" | "service"; receipt?: Receipt; reason?: string; service?: ServiceGrant }
  | { status: "expired"; approvalId: string; kind: "payment" | "service"; service?: ServiceGrant }
  | {
      status: "approved";
      approvalId: string;
      kind: "payment" | "service";
      paymentId: string;
      /** For x402 payments: header to retry with. Absent for direct transfers. */
      paymentHeader?: string;
      /** For x402 payments: what to retry (url, method, body), so a restarted agent can resume. */
      request?: OriginalRequest;
      /** Payment approvals only. */
      receipt?: Receipt;
      /** Service approvals only: the connection that was made. */
      service?: ConnectedService;
    };

/** POST /v1/earnings (agent token) — record a bounty payout the agent received. */
export interface EarningRequest {
  amount: string;
  txHash: Hex;
  description: string;
  from: { address?: Address; origin: string; name?: string };
  bountyId?: string;
}

/** GET /v1/me (agent token) */
export interface MeResponse {
  agent: AgentPublic;
  limits: { maxPerTx: string; dailyCap: string; approvalThreshold: string; remainingToday: string };
}

/** POST /v1/agents (owner) */
export interface CreateAgentRequest {
  /** Lowercase letters, digits and dashes, 2–32 chars, starting with a letter or digit. */
  name: string;
  policy?: Partial<Policy>;
  /** Mock mode only: initial balance to mint, dollars. */
  initialBalance?: string;
  /** Directory service ids to connect right away (connectedBy "owner"). */
  services?: string[];
}

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** Largest single mock top-up, dollars. */
export const MAX_TOPUP = "1000.00";
export interface CreateAgentResponse {
  agent: AgentPublic;
  /** Shown exactly once. */
  token: string;
  tokenId: string;
}

/** GET /v1/summary (owner) */
export interface SummaryResponse {
  totalBalance: string;
  spentToday: string;
  earnedToday: string;
  agents: AgentPublic[];
  pendingApprovals: Approval[];
  chainMode: "mock" | "base-sepolia";
  telegramConnected: boolean;
}

/** Standard error body for 4xx/5xx. */
export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// ----------------------------------------------------------------------------
// agent-work protocol (see docs/agent-work-spec.md)
// ----------------------------------------------------------------------------

export type BountyStatus = "open" | "full" | "closed";

export interface BountyDoc {
  id: string;
  title: string;
  description: string;
  /** Free-form task type, e.g. "api_reliability_check", "summarize", "label". */
  taskType: string;
  /** Task-specific input the agent needs to do the work. */
  input: Record<string, unknown>;
  payout: { amount: string; asset: "USDC"; network: string };
  slots: { total: number; remaining: number };
  claimTtlSeconds: number;
  claimUrl: string;
  submitUrl: string;
  /** Human note about how work is verified. */
  verification: string;
  status: BountyStatus;
}

export interface AgentWorkDoc {
  protocol: "agent-work";
  version: "0.1";
  site: { name: string; url: string };
  bounties: BountyDoc[];
}

export interface ClaimRequest {
  walletAddress: Address;
  agentName?: string;
}

export interface ClaimResponse {
  claimId: string;
  bountyId: string;
  walletAddress: Address;
  expiresAt: IsoDate;
  submitUrl: string;
  input: Record<string, unknown>;
}

export interface SubmitRequest {
  claimId: string;
  walletAddress: Address;
  result: unknown;
}

export interface PayoutResponse {
  status: "paid";
  claimId: string;
  bountyId: string;
  amount: string;
  asset: "USDC";
  network: string;
  to: Address;
  txHash: Hex;
  explorerUrl?: string;
  paidAt: IsoDate;
}

export type AgentWorkErrorCode =
  | "bounty_not_found"
  | "bounty_full"
  | "already_claimed"
  | "claim_not_found"
  | "claim_expired"
  | "rejected"
  | "payout_failed"
  | "invalid_request";

export interface AgentWorkError {
  error: AgentWorkErrorCode;
  message: string;
  /** For 422 rejected: what was wrong. The claim stays open so the agent can retry. */
  details?: unknown;
}
