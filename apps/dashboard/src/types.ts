/**
 * Type-only re-exports from the shared contract. The runtime imports from the shared package are
 * the pure "@allowance/shared/avatars" entry and two constants from its pure types file
 * (sheets.ts); the main entry's config loader uses node:fs, so it must never be bundled.
 */
export type {
  AgentPublic,
  BankAccountView,
  BankStatementEntry,
  BankStatementResponse,
  BankSummary,
  CreateAgentRequest,
  CreateAgentResponse,
  Approval,
  ApprovalStatus,
  ConnectedService,
  EventType,
  Policy,
  Receipt,
  ReceiptBank,
  ReceiptKind,
  ReceiptStatus,
  ServiceCategory,
  ServiceGrant,
  ServiceKind,
  ServiceAddResponse,
  ServiceLinkKind,
  ServiceManifest,
  ServicePreviewResponse,
  ShopifyStore,
  ShopifyStoreRef,
  SummaryResponse,
  WalletEvent,
  Address,
  Hex,
} from "@allowance/shared";

import type { ServiceAddResponse, ServiceLinkKind, ServiceManifest, ServicePreviewResponse } from "@allowance/shared";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "offline" | "demo";

/** Owner view of a directory entry (§13.2): list entries omit `docs`; `connectedAgents` are agent ids. */
export type DirectoryService = Omit<ServiceManifest, "docs"> & { docs?: string; connectedAgents?: string[] };

/** `POST /v1/directory/shopify` (§15.3). `maxPrice` is the per-order cap; `connectTo` are agent ids. */
export interface AddShopifyStoreRequest {
  url: string;
  maxPrice?: string;
  connectTo?: string[];
}

/** What a pasted link turned out to be (§18): a directory service, a Shopify store, or an x402 API. */
export type ResolvedKind = ServiceLinkKind;

/** `GET /v1/directory/preview?url=` (§18). `connectedAgents` are agent ids; `listed` (stores) and `price` (x402). */
export type ServicePreview = ServicePreviewResponse;

/** `POST /v1/directory/add` (§18). `maxPrice` is the cap (per order for a store); `connectTo` are agent ids. */
export interface AddServiceRequest {
  url: string;
  maxPrice?: string;
  connectTo?: string[];
}
/** `connected`: every agent that has it after the call. */
export type AddServiceResponse = ServiceAddResponse;

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
  // Capital One (Nessie sandbox) mirror of a receipt (§16.3): they update a receipt's marker in place.
  "bank.posted",
  "bank.failed",
] as const;
