/**
 * Type-only re-exports from the shared contract. Nothing from @allowance/shared is
 * imported at runtime (its config loader uses node:fs), so Vite never bundles it.
 */
export type {
  AgentPublic,
  Approval,
  ApprovalStatus,
  EventType,
  Policy,
  Receipt,
  ReceiptKind,
  ReceiptStatus,
  SummaryResponse,
  WalletEvent,
  Address,
  Hex,
} from "@allowance/shared";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "demo";

/** All event types, in one place, so the SSE client can subscribe to each named event. */
export const EVENT_TYPES = [
  "agent.created",
  "agent.frozen",
  "agent.unfrozen",
  "policy.updated",
  "token.revoked",
  "payment.signed",
  "payment.settled",
  "payment.needs_approval",
  "payment.blocked",
  "approval.approved",
  "approval.denied",
  "transfer.sent",
  "earning.received",
  "topup",
] as const;
