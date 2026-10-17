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
  | "insufficient_balance";

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
}

// ----------------------------------------------------------------------------
// Agents, tokens
// ----------------------------------------------------------------------------

export interface AgentPublic {
  id: string;
  name: string;
  address: Address;
  policy: Policy;
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
  agentId: string;
  agentName: string;
  paymentId: string;
  amount: string;
  description: string;
  counterparty: { address: Address; origin?: string; name?: string };
  status: ApprovalStatus;
  createdAt: IsoDate;
  decidedAt?: IsoDate;
  /** "telegram" | "dashboard" | "auto" */
  decidedBy?: string;
}

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
  | "topup";

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
  | { status: "pending"; approvalId: string }
  | { status: "denied"; approvalId: string; receipt: Receipt }
  | { status: "expired"; approvalId: string }
  | {
      status: "approved";
      approvalId: string;
      paymentId: string;
      /** For x402 payments: header to retry with. Absent for direct transfers. */
      paymentHeader?: string;
      receipt: Receipt;
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
  name: string;
  policy?: Partial<Policy>;
  /** Mock mode only: initial balance to mint, dollars. */
  initialBalance?: string;
}
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
