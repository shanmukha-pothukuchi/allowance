/**
 * Type-only re-exports from the shared contract. The only runtime import from
 * @allowance/shared is the pure "@allowance/shared/avatars" entry (the main entry's config
 * loader uses node:fs, so it must never be bundled).
 */
export type {
  AgentPublic,
  Approval,
  ApprovalStatus,
  ConnectedService,
  EventType,
  Policy,
  Receipt,
  ReceiptKind,
  ReceiptStatus,
  ServiceCategory,
  ServiceGrant,
  ServiceKind,
  ServiceManifest,
  SummaryResponse,
  WalletEvent,
  Address,
  Hex,
} from "@allowance/shared";

import type { ServiceManifest } from "@allowance/shared";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "offline" | "demo";

/** Owner view of a directory entry (§13.2): list entries omit `docs`; `connectedAgents` are agent ids. */
export type DirectoryService = Omit<ServiceManifest, "docs"> & { docs?: string; connectedAgents?: string[] };

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
  "service.requested",
  "service.connected",
  "service.disconnected",
] as const;
