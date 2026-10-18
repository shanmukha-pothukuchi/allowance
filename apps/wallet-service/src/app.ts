/**
 * Wallet-service HTTP app (Express 5). Implements docs/ARCHITECTURE.md §6 exactly.
 * `createApp` does not listen; `index.ts` does. Tests mount it on port 0.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  allowlistMatch,
  buildPaymentPayload,
  findService,
  createSettlement,
  encodePaymentHeader,
  evaluate,
  signTransferAuthorization,
} from "@allowance/wallet";
import type { Settlement } from "@allowance/wallet";
import { AGENT_NAME_RE, MAX_TOPUP, ownerHeaders,
  BASE_SEPOLIA_NETWORK,
  USDC_BASE_SEPOLIA,
  containsSecret,
  explorerTxUrl,
  formatUsd,
  hashToken,
  isSameLocalDay,
  newId,
  nowIso,
  originOf,
  redact,
  toBaseUnits,
  toDollars,
} from "@allowance/shared";
import type {
  Address,
  AgentPublic,
  AppConfig,
  Approval,
  ApprovalWaitResponse,
  ConnectedService,
  CreateAgentRequest,
  EarningRequest,
  EventType,
  Hex,
  MeResponse,
  PayRequest,
  PayResponse,
  Policy,
  PolicyBlockReason,
  Receipt,
  ServiceGrant,
  ServiceManifest,
  ServiceRequest,
  ServiceRequestResponse,
  SettledRequest,
  SummaryResponse,
  TransferRequest,
  TransferResponse,
  WalletEvent,
  X402PaymentRequired, X402PaymentRequirements,
} from "@allowance/shared";
import {
  MAX_EVENTS,
  Store,
  createAgentOffline,
  issueToken,
  normalizePolicy,
  openStore,
  publicToken,
  toAgentPublic,
} from "./store.js";
import type { PendingPayment, StoredAgent } from "./store.js";
import { DirectoryUnavailableError, httpDirectoryClient } from "./directory-client.js";
import type { DirectoryClient } from "./directory-client.js";

const LOG = "[wallet-service]";
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const WAIT_DEFAULT_MS = 45_000;
const WAIT_MAX_MS = 60_000;
const SSE_PING_MS = 15_000;

export interface AppDeps {
  store?: Store;
  settlement?: Settlement;
  /**
   * Re-fetch a 402 challenge and confirm the site really demands `requirements` (payTo, amount,
   * asset, network). Used when a payment relies on the origin allowlist, so an agent cannot
   * smuggle an attacker's payTo under a trusted origin. Defaults to a live fetch.
   */
  verifyChallenge?: VerifyChallenge;
  /** Mock mode: look up a tx on the facilitator to confirm agent-reported settlements/earnings. */
  lookupTx?: LookupTx;
  /** Service directory client. Defaults to HTTP against `config.directoryUrl` (3 s timeout, 30 s list cache). */
  directory?: DirectoryClient;
}

export type VerifyChallenge = (
  url: string,
  method: "GET" | "POST" | undefined,
  requirements: X402PaymentRequirements,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

export interface LedgerTx {
  hash: string;
  from: string;
  to: string;
  amountBaseUnits: string;
  kind?: string;
}
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Block reasons that never freeze: not policy violations, or soft blocks that ask the owner. */
const NON_FREEZING: ReadonlySet<PolicyBlockReason> = new Set(["insufficient_balance", "frozen", "service_not_connected", "service_cap"]);
const MAX_TIMEOUT_SECONDS = 3600;
export type LookupTx = (txHash: string) => Promise<LedgerTx | null | "unavailable">;

/** Live implementation: fetch the URL (no body), expect 402 + PAYMENT-REQUIRED, compare. */
export function liveVerifyChallenge(fetchImpl: typeof fetch = fetch): VerifyChallenge {
  return async (url, method, requirements) => {
    let res: globalThis.Response;
    try {
      res = await fetchImpl(url, {
        method: method ?? "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      return { ok: false, reason: `could not reach ${url}: ${(err as Error).message}` };
    }
    if (res.status !== 402) return { ok: false, reason: `${url} answered ${res.status}, not 402` };
    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) return { ok: false, reason: "402 without PAYMENT-REQUIRED header" };
    let live: X402PaymentRequired;
    try {
      live = decodePaymentRequiredHeader(header) as unknown as X402PaymentRequired;
    } catch {
      return { ok: false, reason: "PAYMENT-REQUIRED header did not decode" };
    }
    const match = (live.accepts ?? []).some(
      (a: X402PaymentRequirements) =>
        a.scheme === requirements.scheme &&
        a.network === requirements.network &&
        String(a.asset).toLowerCase() === String(requirements.asset).toLowerCase() &&
        String(a.payTo).toLowerCase() === String(requirements.payTo).toLowerCase() &&
        String(a.amount) === String(requirements.amount) &&
        Number(a.maxTimeoutSeconds) === Number(requirements.maxTimeoutSeconds),
    );
    return match ? { ok: true } : { ok: false, reason: "the site did not ask for this payTo/amount" };
  };
}

/** Live implementation against the mock facilitator's /tx/:hash. */
export function liveLookupTx(facilitatorUrl: string, fetchImpl: typeof fetch = fetch): LookupTx {
  return async (txHash) => {
    try {
      const res = await fetchImpl(`${facilitatorUrl.replace(/\/+$/, "")}/tx/${txHash}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status >= 400 && res.status < 500) return null; // 404, malformed param, etc.
      if (!res.ok) return "unavailable";
      const tx = (await res.json()) as LedgerTx;
      return tx && tx.hash ? tx : null;
    } catch {
      return "unavailable";
    }
  };
}

export interface WalletApp {
  app: express.Express;
  store: Store;
  settlement: Settlement;
  /** In-process bus: "event" (WalletEvent), "approval:<id>" (Approval). */
  bus: EventEmitter;
  telegramConnected: () => boolean;
  /** Mock mode: mint unapplied seed balances (retries while the facilitator comes up). */
  seedBalances: (opts?: { retryMs?: number }) => Promise<void>;
  /** Stop timers and SSE clients. */
  close: () => void;
}

/** Names the directory service behind a service_not_connected block (extra on the 403 body). */
export interface BlockedService {
  id: string;
  name: string;
  icon: string;
}

/** /wait result: the contract shape plus `kind` on every state and `service` (grant or connection) for service approvals. */
type WaitOut = ApprovalWaitResponse & { kind: "payment" | "service"; service?: ServiceGrant | ConnectedService };

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function createApp(config: AppConfig, deps: AppDeps = {}): WalletApp {
  const store = deps.store ?? openStore(config.dataDir);
  const settlement = deps.settlement ?? createSettlement(config);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  let telegramConnected = false;
  const sseClients = new Set<Response>();

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  const accountOf = (a: StoredAgent) => privateKeyToAccount(a.privateKey);

  function emit(type: EventType, partial: Omit<WalletEvent, "id" | "type" | "at">): WalletEvent {
    const event: WalletEvent = redact({ id: newId("evt"), type, at: nowIso(), ...partial });
    store.state.events.push(event);
    if (store.state.events.length > MAX_EVENTS) store.state.events.splice(0, store.state.events.length - MAX_EVENTS);
    store.save();
    console.log(`${LOG} ${type}: ${event.message}`);
    bus.emit("event", event);
    return event;
  }

  const verifyChallenge: VerifyChallenge = deps.verifyChallenge ?? liveVerifyChallenge();
  const directory: DirectoryClient = deps.directory ?? httpDirectoryClient(config.directoryUrl);
  const lookupTx: LookupTx = deps.lookupTx ?? (config.chainMode === "mock" ? liveLookupTx(config.facilitatorUrl) : async () => "unavailable");
  let seeded = config.chainMode !== "mock";
  /** Approvals being settled right now. Claimed synchronously so two concurrent approve calls
   *  (double-tap, Telegram + dashboard, retries) can never settle the same approval twice. */
  const deciding = new Set<string>();
  /** Payout tx hashes currently being recorded as earnings (same claim-before-await pattern). */
  const recordingTx = new Set<string>();


  /** Look up an agent-reported tx hash. Mock mode fails closed (503) when the ledger is unreachable;
   *  chain mode has no lookup and returns "skip" (documented gap). */
  async function requireTx(hash: unknown): Promise<LedgerTx | "skip"> {
    if (typeof hash !== "string" || !TX_HASH_RE.test(hash)) throw new HttpError(400, "invalid_request", "txHash must be a 0x-prefixed 32-byte hex hash");
    const tx = await lookupTx(hash);
    if (tx === null) throw new HttpError(400, "tx_not_found", "The ledger has no such transaction");
    if (tx === "unavailable") {
      if (config.chainMode === "mock") throw new HttpError(503, "ledger_unavailable", "The ledger is not reachable; retry shortly");
      return "skip";
    }
    return tx;
  }

  /** Spend is counted at signing time. A "failed" report from the agent does NOT un-count an x402
   *  spend: the signed authorization is still valid until validBefore, so trusting the agent here
   *  would let it drain the daily cap (found by the Phase 3 verifier). Transfers are settled by
   *  the wallet itself, so a failed transfer is trustworthy and is not counted. */
  function spentToday(agentId: string): bigint {
    const now = new Date();
    return store.state.receipts
      .filter(
        (r) =>
          r.agentId === agentId &&
          (r.kind === "spend" || r.kind === "transfer") &&
          (r.status === "signed" || r.status === "settled" || (r.status === "failed" && r.kind === "spend")) &&
          isSameLocalDay(r.createdAt, now),
      )
      .reduce((sum, r) => sum + BigInt(r.amountBaseUnits), 0n);
  }

  function earnedToday(agentId: string): bigint {
    const now = new Date();
    return store.state.receipts
      .filter((r) => r.agentId === agentId && r.kind === "earn" && r.status === "settled" && isSameLocalDay(r.createdAt, now))
      .reduce((sum, r) => sum + BigInt(r.amountBaseUnits), 0n);
  }

  async function balanceOf(agent: StoredAgent): Promise<bigint> {
    try {
      return await settlement.balanceOf(agent.address);
    } catch (err) {
      console.warn(`${LOG} balance lookup failed for ${agent.name}: ${(err as Error).message}`);
      return 0n;
    }
  }

  async function agentPublic(agent: StoredAgent): Promise<AgentPublic> {
    return toAgentPublic(agent, {
      balance: await balanceOf(agent),
      spentToday: spentToday(agent.id),
      earnedToday: earnedToday(agent.id),
    });
  }

  function requireAgentById(id: string): StoredAgent {
    const a = store.agentById(id);
    if (!a) throw new HttpError(404, "agent_not_found", `No agent ${id}`);
    return a;
  }

  function newReceipt(partial: Omit<Receipt, "id" | "createdAt" | "network">): Receipt {
    const r: Receipt = { id: newId("rcp"), createdAt: nowIso(), network: BASE_SEPOLIA_NETWORK, ...partial };
    store.state.receipts.push(r);
    return r;
  }

  function freezeAgent(agent: StoredAgent, reason: string, receipt?: Receipt): void {
    agent.policy.frozen = true;
    agent.frozenReason = reason;
    store.save();
    emit("agent.frozen", {
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} frozen: ${reason}`,
      reason,
      receipt,
      data: { cause: "policy_violation", receiptId: receipt?.id },
    });
  }

  /**
   * Shared pre-flight for pay and transfer: balance check, then policy.
   * Returns the decision; on block it already wrote the receipt, events and freeze.
   */
  async function decide(
    agent: StoredAgent,
    spend: { amountBaseUnits: bigint; to: Address; origin?: string; url?: string },
    receiptBase: { kind: "spend" | "transfer"; description: string; counterparty: Receipt["counterparty"]; paymentId: string },
  ): Promise<
    | { outcome: "allow" }
    | { outcome: "needs_approval" }
    | { outcome: "block"; reason: PolicyBlockReason; message: string; frozen: boolean; receipt: Receipt; service?: BlockedService }
  > {
    const amount = spend.amountBaseUnits;
    const balance = await settlement.balanceOf(agent.address).catch((err: Error) => {
      throw new HttpError(503, "ledger_unavailable", `Could not read balance: ${err.message}`);
    });
    // Balance check comes first (contract §6): an unaffordable payment is never a policy violation.
    let directoryDown = false;
    let blockedService: BlockedService | undefined;
    let decision =
      balance < amount
        ? {
            outcome: "block" as const,
            reason: "insufficient_balance" as const,
            message: `Blocked: tried to send ${formatUsd(amount)}${spend.origin ? ` to ${hostOf(spend.origin)}` : ""} but the balance is only ${formatUsd(balance)}.`,
          }
        : evaluate(agent.policy, spentToday(agent.id), spend, { services: agent.services, agentName: agent.name });
    // Not allowlisted with a URL: is it a directory service this agent has not connected (soft block)?
    // The directory is only consulted here, so normal payments never depend on it.
    if (decision.outcome === "block" && decision.reason === "not_allowlisted" && spend.url) {
      try {
        const catalog = await directory.list();
        decision = evaluate(agent.policy, spentToday(agent.id), spend, { services: agent.services, directory: catalog, agentName: agent.name });
        if (decision.outcome === "block" && decision.reason === "service_not_connected") {
          const known = findService(spend.url, catalog);
          if (known) blockedService = { id: known.id, name: known.name, icon: known.icon };
        }
      } catch (err) {
        // Fail closed (still blocked) but do not freeze: it may be a known service we cannot name right now.
        directoryDown = true;
        console.warn(`${LOG} directory unavailable while checking ${agent.name}'s payment to ${spend.url} (${(err as Error).message}); blocking as not_allowlisted without freezing`);
      }
    }
    if (decision.outcome !== "block") return { outcome: decision.outcome };

    const shouldFreeze =
      agent.policy.freezeOnViolation && !NON_FREEZING.has(decision.reason) && !(directoryDown && decision.reason === "not_allowlisted");
    const message = shouldFreeze ? `${decision.message} Agent frozen.` : decision.message;
    const receipt = newReceipt({
      ...receiptBase,
      status: "blocked",
      agentId: agent.id,
      agentName: agent.name,
      amount: toDollars(amount),
      amountBaseUnits: amount.toString(),
      reason: decision.reason,
    });
    store.save();
    emit("payment.blocked", {
      agentId: agent.id,
      agentName: agent.name,
      message,
      reason: decision.reason,
      receipt,
      data: {
        frozen: shouldFreeze || agent.policy.frozen,
        willFreeze: shouldFreeze,
        receiptId: receipt.id,
        ...(blockedService ? { service: blockedService, serviceId: blockedService.id } : {}),
      },
    });
    if (shouldFreeze) freezeAgent(agent, decision.message.replace(/^Blocked: /, ""), receipt);
    return { outcome: "block", reason: decision.reason, message, frozen: agent.policy.frozen, receipt, service: blockedService };
  }

  async function signPayment(agent: StoredAgent, pending: PendingPayment): Promise<string> {
    const signed = await signTransferAuthorization(accountOf(agent), pending.requirements!);
    const payload = buildPaymentPayload(pending.paymentRequired!, pending.requirements!, signed);
    return encodePaymentHeader(payload);
  }

  function openApproval(agent: StoredAgent, pending: PendingPayment, receipt: Receipt, description: string): Approval {
    const approval: Approval = {
      id: newId("apr"),
      kind: "payment",
      agentId: agent.id,
      agentName: agent.name,
      paymentId: pending.paymentId,
      amount: toDollars(BigInt(pending.amountBaseUnits)),
      description,
      counterparty: receipt.counterparty,
      status: "pending",
      createdAt: nowIso(),
    };
    store.state.approvals.push(approval);
    pending.approvalId = approval.id;
    receipt.approvalId = approval.id;
    receipt.status = "pending_approval";
    store.state.pendingPayments[pending.paymentId] = pending;
    store.save();
    const who = receipt.counterparty.name ?? receipt.counterparty.origin ?? "an address";
    emit("payment.needs_approval", {
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} wants to pay ${formatUsd(BigInt(pending.amountBaseUnits))} to ${who}. Approve?`,
      approval,
      receipt,
      data: { approvalId: approval.id, kind: pending.kind },
    });
    return approval;
  }

  function expireApprovals(): void {
    const now = Date.now();
    for (const approval of store.state.approvals) {
      if (approval.status !== "pending" || deciding.has(approval.id)) continue;
      if (now - new Date(approval.createdAt).getTime() < APPROVAL_TTL_MS) continue;
      approval.status = "expired";
      approval.decidedAt = nowIso();
      approval.decidedBy = "auto";
      const receipt = store.state.receipts.find((r) => r.approvalId === approval.id);
      if (receipt) {
        receipt.status = "denied";
        receipt.reason = "expired";
      }
      delete store.state.serviceRequests[approval.id];
      store.save();
      emit("approval.denied", {
        agentId: approval.agentId,
        agentName: approval.agentName,
        message:
          approval.kind === "service"
            ? `Request to connect ${approval.service?.name ?? "a service"} for ${approval.agentName} expired.`
            : `Approval for ${formatUsd(toBaseUnits(approval.amount))} to ${approval.counterparty.name ?? approval.counterparty.origin ?? "an address"} expired.`,
        reason: "expired",
        approval,
        receipt,
      });
      bus.emit(`approval:${approval.id}`, approval);
    }
  }

  async function settleApproval(approval: Approval, by: string): Promise<Approval> {
    if (approval.kind === "service") return settleServiceApproval(approval, by);
    const agent = requireAgentById(approval.agentId);
    const pending = store.state.pendingPayments[approval.paymentId];
    const receipt = store.state.receipts.find((r) => r.approvalId === approval.id);
    if (!pending || !receipt) throw new HttpError(500, "pending_missing", "Parked payment is missing");

    // Re-check the hard rules at approval time (frozen / caps / balance); approval does not override them.
    const amount = BigInt(pending.amountBaseUnits);
    const balance = await settlement.balanceOf(agent.address).catch(() => 0n);
    const recheck = evaluate(
      { ...agent.policy, approvalThreshold: toDollars(amount) },
      spentToday(agent.id),
      { amountBaseUnits: amount, to: pending.to, origin: pending.origin, url: pending.kind === "pay" ? pending.request?.url : undefined },
      { services: agent.services, agentName: agent.name },
    );
    const hardBlock =
      recheck.outcome === "block"
        ? recheck
        : balance < amount
          ? { outcome: "block" as const, reason: "insufficient_balance" as const, message: `Balance is only ${formatUsd(balance)}.` }
          : null;
    if (hardBlock) {
      approval.status = "denied";
      approval.decidedAt = nowIso();
      approval.decidedBy = by;
      receipt.status = "blocked";
      receipt.reason = hardBlock.reason;
      store.save();
      emit("approval.denied", {
        agentId: agent.id,
        agentName: agent.name,
        message: `Approved by ${by}, but ${hardBlock.message}`,
        reason: hardBlock.reason,
        approval,
        receipt,
      });
      bus.emit(`approval:${approval.id}`, approval);
      return approval;
    }

    approval.status = "approved";
    approval.decidedAt = nowIso();
    approval.decidedBy = by;
    const who = receipt.counterparty.name ?? receipt.counterparty.origin ?? "an address";

    if (pending.kind === "pay") {
      pending.paymentHeader = await signPayment(agent, pending);
      receipt.status = "signed";
      store.save();
      emit("approval.approved", {
        agentId: agent.id,
        agentName: agent.name,
        message: `Approved by ${by}: ${agent.name} pays ${formatUsd(amount)} to ${who}.`,
        approval,
        receipt,
        data: { paymentId: pending.paymentId },
      });
    } else {
      try {
        const { txHash, explorerUrl } = await settlement.transfer(accountOf(agent), pending.to, amount, pending.memo);
        receipt.status = "settled";
        receipt.txHash = txHash;
        receipt.explorerUrl = explorerUrl;
        receipt.settledAt = nowIso();
        store.save();
        emit("approval.approved", {
          agentId: agent.id,
          agentName: agent.name,
          message: `Approved by ${by}: ${agent.name} sent ${formatUsd(amount)} to ${who}.`,
          approval,
          receipt,
        });
        emit("transfer.sent", {
          agentId: agent.id,
          agentName: agent.name,
          message: `${agent.name} sent ${formatUsd(amount)} to ${who}.`,
          receipt,
        });
      } catch (err) {
        receipt.status = "failed";
        receipt.reason = (err as { errorReason?: string }).errorReason ?? "settlement_failed";
        store.save();
        emit("approval.approved", {
          agentId: agent.id,
          agentName: agent.name,
          message: `Approved by ${by}, but the transfer of ${formatUsd(amount)} failed: ${(err as Error).message}`,
          reason: receipt.reason,
          approval,
          receipt,
        });
      }
    }
    bus.emit(`approval:${approval.id}`, approval);
    return approval;
  }

  // ---------------------------------------------------------------------------
  // services (docs/ARCHITECTURE.md §13.2)
  // ---------------------------------------------------------------------------

  /** Connect a service to an agent (idempotent). Emits service.connected when something changed. */
  function connectService(
    agent: StoredAgent,
    grant: ServiceGrant,
    connectedBy: ConnectedService["connectedBy"],
    docs?: string,
    approvalId?: string,
  ): ConnectedService {
    const existing = agent.services.find((s) => s.id === grant.id);
    if (existing) return existing;
    const service: ConnectedService = { ...toGrant(grant), connectedAt: nowIso(), connectedBy, ...(docs ? { docs } : {}) };
    agent.services.push(service);
    store.save();
    emit("service.connected", {
      agentId: agent.id,
      agentName: agent.name,
      message: `${service.name} connected to ${agent.name}.`,
      data: { service, serviceId: service.id, connectedBy, ...(approvalId ? { approvalId } : {}) },
    });
    return service;
  }

  /** Approving a service request connects exactly what the owner was shown (the stored grant). */
  function settleServiceApproval(approval: Approval, by: string): Approval {
    const agent = requireAgentById(approval.agentId);
    const request = store.state.serviceRequests[approval.id];
    const grant = request?.grant ?? approval.service;
    if (!grant) throw new HttpError(500, "pending_missing", "The service request is missing");
    approval.status = "approved";
    approval.decidedAt = nowIso();
    approval.decidedBy = by;
    delete store.state.serviceRequests[approval.id];
    store.save();
    emit("approval.approved", {
      agentId: agent.id,
      agentName: agent.name,
      message: `Approved by ${by}: ${grant.name} connected to ${agent.name}.`,
      approval,
      data: { service: grant },
    });
    connectService(agent, grant, "approval", request?.docs, approval.id);
    bus.emit(`approval:${approval.id}`, approval);
    return approval;
  }

  async function directoryCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) {
        console.warn(`${LOG} ${err.message}`);
        throw new HttpError(503, "directory_unavailable", "The service directory is not reachable right now; try again shortly.");
      }
      throw err;
    }
  }

  /** Manifest from the directory, or 404 service_not_found / 503 directory_unavailable. */
  async function requireManifest(id: string): Promise<ServiceManifest> {
    if (!SERVICE_ID_RE.test(id)) throw new HttpError(400, "invalid_request", "serviceId must be a directory id like \"acme-pizza\"");
    const manifest = await directoryCall(() => directory.get(id));
    if (!manifest) throw new HttpError(404, "service_not_found", `No service "${id}" in the directory. Use search_services to find one.`);
    return manifest;
  }

  /** A connected custom service rendered as a manifest (its docs are the agent's own). */
  function customManifest(c: ConnectedService): ServiceManifest {
    return { ...toGrant(c), description: c.summary, category: "tools", docs: c.docs ?? "", source: "agent" };
  }

  /** The directory never appears in agent.services; a synthetic connection answers requests for it. */
  function directoryConnection(agent: StoredAgent, m?: ServiceManifest): ConnectedService {
    return {
      id: "directory",
      name: m?.name ?? "Service Directory",
      provider: m?.provider ?? "Allowance",
      icon: m?.icon ?? "🧭",
      color: m?.color ?? "#6E7BF2",
      kind: "directory",
      summary: m?.summary ?? "Find services you can connect to.",
      baseUrl: m?.baseUrl ?? config.directoryUrl,
      pricing: "Free",
      maxPrice: "0.00",
      permissions: m?.permissions ?? [],
      source: "directory",
      connectedAt: agent.createdAt,
      connectedBy: "default",
    };
  }

  /** Validate an agent's custom proposal (§13.2) into a grant flagged source:"agent". */
  function customGrant(agent: StoredAgent, raw: unknown): { grant: ServiceGrant; docs?: string } {
    const c = raw as Partial<NonNullable<ServiceRequest["custom"]>> | null;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new HttpError(400, "invalid_request", "`custom` must be { name, baseUrl, summary, maxPrice, docs? }");
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name || name.length > 60) throw new HttpError(400, "invalid_request", "custom.name is required, at most 60 characters");
    const summary = typeof c.summary === "string" ? c.summary.trim() : "";
    if (!summary || summary.length > 200) throw new HttpError(400, "invalid_request", "custom.summary is required, at most 200 characters");
    let url: URL;
    try {
      if (typeof c.baseUrl !== "string" || c.baseUrl.length > 500) throw new Error("bad");
      url = new URL(c.baseUrl.trim());
    } catch {
      throw new HttpError(400, "invalid_request", "custom.baseUrl must be a full http(s) URL like https://api.example.com/v1");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new HttpError(400, "invalid_request", "custom.baseUrl must be a plain http(s) URL (no credentials, query or fragment)");
    }
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    let maxPriceUnits: bigint;
    try {
      if (typeof c.maxPrice !== "string") throw new Error("not a string");
      maxPriceUnits = toBaseUnits(c.maxPrice);
    } catch {
      throw new HttpError(400, "invalid_request", "custom.maxPrice must be a dollar string like \"0.50\"");
    }
    if (maxPriceUnits < 0n) throw new HttpError(400, "invalid_request", "custom.maxPrice must be >= 0");
    if (maxPriceUnits > toBaseUnits(agent.policy.maxPerTx)) {
      throw new HttpError(400, "invalid_request", `custom.maxPrice ${formatUsd(maxPriceUnits)} is over this agent's ${formatUsd(toBaseUnits(agent.policy.maxPerTx))} per-payment limit`);
    }
    if (c.docs !== undefined && (typeof c.docs !== "string" || c.docs.length > 20_000)) {
      throw new HttpError(400, "invalid_request", "custom.docs must be a string of at most 20000 characters");
    }
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "service";
    let id = `custom-${slug}`;
    const clash = (x: string) =>
      agent.services.some((s) => s.id === x && s.baseUrl !== baseUrl) ||
      store.state.approvals.some((a) => a.status === "pending" && a.agentId === agent.id && a.service?.id === x && a.service.baseUrl !== baseUrl);
    if (clash(id)) id = `${id}-${randomBytes(2).toString("hex")}`;
    const maxPrice = toDollars(maxPriceUnits);
    const host = url.host;
    const grant: ServiceGrant = {
      id,
      name,
      provider: `Proposed by ${agent.name}`,
      icon: "🔌",
      color: "#8A8F98",
      kind: "x402",
      category: "tools",
      summary,
      baseUrl,
      pricing: maxPriceUnits === 0n ? "Free" : `Up to ${formatUsd(maxPriceUnits)} per payment`,
      maxPrice,
      permissions:
        maxPriceUnits === 0n
          ? [`Use ${name} at ${host} (no payments)`]
          : [`Pay up to ${formatUsd(maxPriceUnits)} per payment to ${name} (${host})`],
      source: "agent",
    };
    return { grant, docs: typeof c.docs === "string" && c.docs.trim() ? c.docs : undefined };
  }

  function openServiceApproval(agent: StoredAgent, grant: ServiceGrant, reason: string | undefined, docs: string | undefined): Approval {
    const approval: Approval = {
      id: newId("apr"),
      kind: "service",
      agentId: agent.id,
      agentName: agent.name,
      paymentId: "",
      amount: toDollars(toBaseUnits(grant.maxPrice)),
      description: grant.source === "agent" ? `Connect ${grant.name} (proposed by ${agent.name})` : `Connect ${grant.name}`,
      counterparty: { address: ZERO_ADDRESS, origin: originOf(grant.baseUrl) || undefined, name: grant.name },
      service: grant,
      reason,
      status: "pending",
      createdAt: nowIso(),
    };
    store.state.approvals.push(approval);
    store.state.serviceRequests[approval.id] = { approvalId: approval.id, agentId: agent.id, grant, docs, createdAt: approval.createdAt };
    store.save();
    emit("service.requested", {
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} wants to connect ${grant.name}.`,
      approval,
      data: { approvalId: approval.id, service: grant, custom: grant.source === "agent" },
    });
    return approval;
  }

  async function mint(agent: StoredAgent, dollars: string): Promise<{ txHash: Hex; balance: string }> {
    const res = await fetch(`${config.facilitatorUrl.replace(/\/+$/, "")}/admin/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(config) },
      body: JSON.stringify({ to: agent.address, amount: dollars }),
    });
    if (!res.ok) throw new Error(`facilitator mint failed (${res.status})`);
    return (await res.json()) as { txHash: Hex; balance: string };
  }

  function recordTopup(agent: StoredAgent, dollars: string, txHash: Hex, description: string): Receipt {
    const amount = toBaseUnits(dollars);
    const receipt = newReceipt({
      kind: "topup",
      status: "settled",
      agentId: agent.id,
      agentName: agent.name,
      description,
      amount: toDollars(amount),
      amountBaseUnits: amount.toString(),
      counterparty: { address: "0x0000000000000000000000000000000000000000", name: "Mock USDC faucet" },
      txHash,
      explorerUrl: explorerTxUrl(txHash, config.chainMode, config.facilitatorUrl),
      settledAt: nowIso(),
    });
    store.save();
    emit("topup", {
      agentId: agent.id,
      agentName: agent.name,
      message: `Added ${formatUsd(amount)} to ${agent.name}.`,
      receipt,
    });
    return receipt;
  }

  async function seedBalances(opts: { retryMs?: number } = {}): Promise<void> {
    if (config.chainMode !== "mock") return;
    const todo = store.state.agents.filter((a) => a.seedBalance && !a.seedApplied);
    if (todo.length === 0) {
      seeded = true;
      return;
    }
    const deadline = Date.now() + (opts.retryMs ?? 15_000);
    for (;;) {
      try {
        const res = await fetch(`${config.facilitatorUrl.replace(/\/+$/, "")}/health`);
        if (res.ok) break;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) {
        console.warn(`${LOG} facilitator not reachable at ${config.facilitatorUrl}; ${todo.length} agent(s) still unseeded`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const agent of todo) {
      try {
        const { txHash } = await mint(agent, agent.seedBalance!);
        agent.seedApplied = true;
        store.save();
        recordTopup(agent, agent.seedBalance!, txHash, "Starting balance");
      } catch (err) {
        console.warn(`${LOG} seeding ${agent.name} failed: ${(err as Error).message}`);
      }
    }
    seeded = true;
  }

  // ---------------------------------------------------------------------------
  // express
  // ---------------------------------------------------------------------------

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Every JSON response is redacted and scrubbed for private keys.
  app.use((_req, res, next) => {
    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      let text = JSON.stringify(redact(body));
      if (text && containsSecret(text, store.secrets())) {
        console.error(`${LOG} SECURITY: a private key almost left the service; scrubbed`);
        for (const s of store.secrets()) {
          text = text.split(s).join("[redacted]").split(s.replace(/^0x/, "")).join("[redacted]");
        }
      }
      res.type("application/json");
      return res.send(text);
    }) as Response["json"];
    next();
  });

  // Auth
  type AuthedRequest = Request & { agent?: StoredAgent };
  function agentFromRequest(req: Request): StoredAgent | undefined {
    const h = req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) return undefined;
    const tok = store.tokenByHash(hashToken(m[1]));
    if (!tok) throw new HttpError(401, "unauthorized", "Unknown agent token");
    if (tok.revokedAt) throw new HttpError(401, "token_revoked", "This token was revoked");
    const agent = store.agentById(tok.agentId);
    if (!agent) throw new HttpError(401, "unauthorized", "Agent no longer exists");
    return agent;
  }
  const agentAuth = (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const agent = agentFromRequest(req);
    if (!agent) throw new HttpError(401, "unauthorized", "Missing Authorization: Bearer <agent token>");
    req.agent = agent;
    next();
  };
  const ownerAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (config.ownerApiKey && req.header("x-owner-key") !== config.ownerApiKey) {
      throw new HttpError(401, "unauthorized", "X-Owner-Key required");
    }
    // Defense in depth for keyless dev setups: an agent token never opens an owner endpoint.
    if (!config.ownerApiKey && /^Bearer\s/i.test(req.header("authorization") ?? "")) {
      throw new HttpError(401, "unauthorized", "Agent tokens cannot call owner endpoints");
    }
    next();
  };

  const router = express.Router();
  app.use("/v1", router);

  // ---- health / summary ----------------------------------------------------

  router.get("/health", (_req, res) => {
    res.json({ ok: true, chainMode: config.chainMode, facilitatorUrl: config.facilitatorUrl, telegramConnected, seeded });
  });

  router.post("/notifier/status", ownerAuth, (req, res) => {
    telegramConnected = Boolean(req.body?.connected);
    console.log(`${LOG} notifier ${telegramConnected ? "connected" : "disconnected"}`);
    res.json({ ok: true, telegramConnected });
  });

  router.get("/summary", ownerAuth, async (_req, res) => {
    expireApprovals();
    const agents = await Promise.all(store.state.agents.map(agentPublic));
    const sum = (f: (a: AgentPublic) => string) => agents.reduce((s, a) => s + toBaseUnits(f(a)), 0n);
    const body: SummaryResponse = {
      totalBalance: toDollars(sum((a) => a.balance)),
      spentToday: toDollars(sum((a) => a.spentToday)),
      earnedToday: toDollars(sum((a) => a.earnedToday)),
      agents,
      pendingApprovals: store.state.approvals.filter((a) => a.status === "pending"),
      chainMode: config.chainMode,
      telegramConnected,
    };
    res.json(body);
  });

  // ---- agent endpoints -----------------------------------------------------

  router.get("/me", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    const pub = await agentPublic(agent);
    const remaining = toBaseUnits(agent.policy.dailyCap) - spentToday(agent.id);
    const body: MeResponse = {
      agent: pub,
      limits: {
        maxPerTx: agent.policy.maxPerTx,
        dailyCap: agent.policy.dailyCap,
        approvalThreshold: agent.policy.approvalThreshold,
        remainingToday: toDollars(remaining < 0n ? 0n : remaining),
      },
    };
    res.json(body);
  });

  router.post("/pay", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    const body = req.body as Partial<PayRequest>;
    const pr = body?.paymentRequired;
    if (!pr || !Array.isArray(pr.accepts) || typeof body.url !== "string") {
      throw new HttpError(400, "invalid_request", "Body must be { paymentRequired, url, description? }");
    }
    const requirements = pr.accepts.find(
      (a) => a?.network === BASE_SEPOLIA_NETWORK && String(a.asset).toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() && a.scheme === "exact",
    );
    if (!requirements) {
      res.status(403).json({
        error: "unsupported_requirements",
        status: "blocked",
        reason: "unsupported_requirements",
        message: "Blocked: this site does not accept USDC on Base Sepolia (eip155:84532).",
        frozen: agent.policy.frozen,
      });
      return;
    }
    if (!/^\d+$/.test(String(requirements.amount)) || !isAddress(String(requirements.payTo))) {
      throw new HttpError(400, "invalid_request", "Payment requirements have an invalid amount or payTo");
    }
    const mts = Number(requirements.maxTimeoutSeconds);
    if (typeof requirements.maxTimeoutSeconds !== "number" || !Number.isInteger(mts) || mts < 1 || mts > MAX_TIMEOUT_SECONDS) {
      throw new HttpError(400, "invalid_request", `maxTimeoutSeconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`);
    }
    requirements.maxTimeoutSeconds = mts; // coerced once; the signer adds it to `now`
    const amount = BigInt(requirements.amount);
    const to = getAddress(requirements.payTo);
    const origin = originOf(body.url) || undefined;
    const description = body.description || pr.resource?.description || pr.resource?.serviceName || origin || "Payment";
    const name = body.description || pr.resource?.serviceName || pr.resource?.description || (origin ? hostOf(origin) : undefined);
    const paymentId = newId("pay");
    const counterparty: Receipt["counterparty"] = { address: to, origin, name };

    // Allowlist by origin or by connected service is only as trustworthy as the URL the agent gave
    // us. If this payment relies on either (payTo not explicitly allowlisted), re-fetch the 402
    // ourselves and confirm the site really demands this payTo/amount before signing.
    let effectiveOrigin = origin;
    let effectiveUrl: string | undefined = body.url;
    const al = agent.policy.allowlist;
    const match = al ? allowlistMatch(al, { to, origin, url: body.url }, agent.services) : null;
    if (match && match.via !== "address") {
      const v = await verifyChallenge(body.url, body.method, requirements as X402PaymentRequirements);
      if (!v.ok) {
        console.warn(`${LOG} challenge verification failed for ${agent.name} at ${body.url}: ${v.reason}`);
        effectiveOrigin = undefined; // falls through to not_allowlisted (block + freeze)
        effectiveUrl = undefined;
      }
    }

    const decision = await decide(agent, { amountBaseUnits: amount, to, origin: effectiveOrigin, url: effectiveUrl }, { kind: "spend", description, counterparty, paymentId });
    if (decision.outcome === "block") {
      // service_not_connected also names the service, so the agent can request_service it directly.
      const out: PayResponse & { service?: BlockedService; serviceId?: string } = {
        status: "blocked",
        reason: decision.reason,
        message: decision.message,
        frozen: decision.frozen,
        receipt: decision.receipt,
        ...(decision.service ? { service: decision.service, serviceId: decision.service.id } : {}),
      };
      res.status(403).json(out);
      return;
    }

    const receipt = newReceipt({
      kind: "spend",
      status: "signed",
      agentId: agent.id,
      agentName: agent.name,
      description,
      amount: toDollars(amount),
      amountBaseUnits: amount.toString(),
      counterparty,
      paymentId,
    });
    const pending: PendingPayment = {
      paymentId,
      agentId: agent.id,
      receiptId: receipt.id,
      kind: "pay",
      amountBaseUnits: amount.toString(),
      to,
      origin,
      paymentRequired: pr as PayRequest["paymentRequired"],
      requirements: requirements as X402PaymentRequirements,
      request: {
        url: String((req.body as PayRequest).url),
        method: (req.body as PayRequest).method,
        body: (req.body as PayRequest).body,
      },
      createdAt: nowIso(),
    };

    if (decision.outcome === "needs_approval") {
      const approval = openApproval(agent, pending, receipt, description);
      const out: PayResponse = {
        status: "needs_approval",
        paymentId,
        approvalId: approval.id,
        amount: toDollars(amount),
        message: `${formatUsd(amount)} to ${name ?? "this site"} needs your owner's approval.`,
        receipt,
      };
      res.status(202).json(out);
      return;
    }

    const paymentHeader = await signPayment(agent, pending);
    pending.paymentHeader = paymentHeader;
    store.state.pendingPayments[paymentId] = pending;
    store.save();
    emit("payment.signed", {
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} is paying ${formatUsd(amount)} to ${name ?? description}.`,
      receipt,
      data: { paymentId },
    });
    const out: PayResponse = { status: "approved", paymentId, paymentHeader, receipt };
    res.json(out);
  });

  router.post("/payments/:paymentId/settled", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    const receipt = store.state.receipts.find((r) => r.paymentId === String(req.params.paymentId) && r.agentId === agent.id);
    if (!receipt) throw new HttpError(404, "payment_not_found", `No payment ${String(req.params.paymentId)} for this agent`);
    const settle = (req.body as Partial<SettledRequest>)?.settleResponse;
    if (!settle || typeof settle.success !== "boolean") {
      throw new HttpError(400, "invalid_request", "Body must be { settleResponse }");
    }
    if (receipt.status === "settled") {
      res.json({ receipt });
      return;
    }
    const who = receipt.counterparty.name ?? receipt.description;
    if (settle.success && settle.transaction) {
      const tx = await requireTx(settle.transaction);
      if (tx !== "skip") {
        const okTx =
          tx.from.toLowerCase() === agent.address.toLowerCase() &&
          tx.to.toLowerCase() === receipt.counterparty.address.toLowerCase() &&
          String(tx.amountBaseUnits) === receipt.amountBaseUnits;
        if (!okTx) throw new HttpError(400, "tx_mismatch", "That transaction does not match this payment");
      }
      receipt.status = "settled";
      receipt.txHash = settle.transaction as Hex;
      receipt.explorerUrl = explorerTxUrl(settle.transaction, config.chainMode, config.facilitatorUrl);
      receipt.settledAt = nowIso();
      store.save();
      emit("payment.settled", {
        agentId: agent.id,
        agentName: agent.name,
        message: `${agent.name} paid ${formatUsd(BigInt(receipt.amountBaseUnits))} to ${who}.`,
        receipt,
      });
    } else {
      receipt.status = "failed";
      receipt.reason = settle.errorReason ?? "settlement_failed";
      store.save();
      emit("payment.settled", {
        agentId: agent.id,
        agentName: agent.name,
        message: `Payment of ${formatUsd(BigInt(receipt.amountBaseUnits))} to ${who} failed (${receipt.reason}).`,
        reason: receipt.reason,
        receipt,
      });
    }
    delete store.state.pendingPayments[receipt.paymentId!];
    store.save();
    res.json({ receipt });
  });

  router.post("/transfer", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    const body = req.body as Partial<TransferRequest>;
    if (!body || typeof body.to !== "string" || !isAddress(body.to)) {
      throw new HttpError(400, "invalid_request", "`to` must be a 0x address");
    }
    let amount: bigint;
    try {
      if (typeof body.amount !== "string" || body.amount.trim() !== body.amount) throw new Error("not a string");
      amount = toBaseUnits(body.amount);
    } catch {
      throw new HttpError(400, "invalid_request", "`amount` must be a dollar string like \"1.50\"");
    }
    if (amount <= 0n) throw new HttpError(400, "invalid_request", "`amount` must be positive");
    const to = getAddress(body.to);
    const memo = typeof body.memo === "string" ? body.memo.slice(0, 200) : undefined;
    const description = memo ? `Transfer: ${memo}` : "Transfer";
    const paymentId = newId("pay");
    const counterparty: Receipt["counterparty"] = { address: to };

    const decision = await decide(agent, { amountBaseUnits: amount, to }, { kind: "transfer", description, counterparty, paymentId });
    if (decision.outcome === "block") {
      const out: TransferResponse = { status: "blocked", reason: decision.reason, message: decision.message, frozen: decision.frozen, receipt: decision.receipt };
      res.status(403).json(out);
      return;
    }

    const receipt = newReceipt({
      kind: "transfer",
      status: "signed",
      agentId: agent.id,
      agentName: agent.name,
      description,
      amount: toDollars(amount),
      amountBaseUnits: amount.toString(),
      counterparty,
      paymentId,
    });
    const pending: PendingPayment = {
      paymentId,
      agentId: agent.id,
      receiptId: receipt.id,
      kind: "transfer",
      amountBaseUnits: amount.toString(),
      to,
      memo,
      createdAt: nowIso(),
    };

    if (decision.outcome === "needs_approval") {
      const approval = openApproval(agent, pending, receipt, description);
      const out: TransferResponse = {
        status: "needs_approval",
        approvalId: approval.id,
        amount: toDollars(amount),
        message: `Sending ${formatUsd(amount)} needs your owner's approval.`,
        receipt,
      };
      res.status(202).json(out);
      return;
    }

    store.save();
    try {
      const { txHash, explorerUrl } = await settlement.transfer(accountOf(agent), to, amount, memo);
      receipt.status = "settled";
      receipt.txHash = txHash;
      receipt.explorerUrl = explorerUrl;
      receipt.settledAt = nowIso();
      store.save();
      emit("transfer.sent", {
        agentId: agent.id,
        agentName: agent.name,
        message: `${agent.name} sent ${formatUsd(amount)}${memo ? ` (${memo})` : ""}.`,
        receipt,
      });
      const out: TransferResponse = { status: "sent", receipt };
      res.json(out);
    } catch (err) {
      receipt.status = "failed";
      receipt.reason = (err as { errorReason?: string }).errorReason ?? "settlement_failed";
      store.save();
      throw new HttpError(502, "settlement_failed", `Transfer failed: ${(err as Error).message}`, { receipt });
    }
  });

  router.get("/approvals/:id/wait", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    expireApprovals();
    const approval = store.approvalById(String(req.params.id));
    if (!approval || approval.agentId !== agent.id) throw new HttpError(404, "approval_not_found", `No approval ${String(req.params.id)}`);
    // Any finite number is honoured (0 = check now); only a missing or non-numeric value means the default.
    const rawTimeout = typeof req.query.timeoutMs === "string" && req.query.timeoutMs.trim() !== "" ? Number(req.query.timeoutMs) : NaN;
    const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(WAIT_MAX_MS, Math.max(0, rawTimeout)) : WAIT_DEFAULT_MS;

    // Every result carries `kind`; service approvals carry `service` in every state (the grant, or
    // the connection once approved).
    const respond = (a: Approval) => {
      if (a.kind === "service") {
        let out: WaitOut;
        const grant = a.service ? toGrant(a.service) : undefined;
        if (a.status === "approved") {
          const service =
            agent.services.find((s) => s.id === a.service?.id) ??
            ({ ...grant!, connectedAt: a.decidedAt ?? nowIso(), connectedBy: "approval" } as ConnectedService);
          out = { kind: "service", status: "approved", approvalId: a.id, paymentId: "", service };
        } else if (a.status === "denied") {
          out = { kind: "service", status: "denied", approvalId: a.id, reason: "denied_by_owner", service: grant };
        } else if (a.status === "expired") {
          out = { kind: "service", status: "expired", approvalId: a.id, service: grant };
        } else {
          out = { kind: "service", status: "pending", approvalId: a.id, service: grant };
        }
        res.json(out);
        return;
      }
      const receipt = store.state.receipts.find((r) => r.approvalId === a.id)!;
      const pending = store.state.pendingPayments[a.paymentId];
      let out: WaitOut;
      if (a.status === "approved") {
        out = {
          kind: "payment",
          status: "approved",
          approvalId: a.id,
          paymentId: a.paymentId,
          paymentHeader: pending?.paymentHeader,
          request: pending?.request,
          receipt,
        };
      } else if (a.status === "denied") {
        out = { kind: "payment", status: "denied", approvalId: a.id, receipt };
      } else if (a.status === "expired") {
        out = { kind: "payment", status: "expired", approvalId: a.id };
      } else {
        out = { kind: "payment", status: "pending", approvalId: a.id };
      }
      res.json(out);
    };

    if (approval.status !== "pending" || timeoutMs === 0) {
      respond(approval);
      return;
    }
    await new Promise<void>((resolve) => {
      const key = `approval:${approval.id}`;
      const done = (a: Approval) => {
        clearTimeout(timer);
        bus.off(key, done);
        res.off("close", onClose);
        respond(a);
        resolve();
      };
      const onClose = () => {
        clearTimeout(timer);
        bus.off(key, done);
        resolve();
      };
      const timer = setTimeout(() => done(store.approvalById(approval.id)!), timeoutMs);
      bus.once(key, done);
      res.once("close", onClose);
    });
  });

  router.post("/earnings", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    const body = req.body as Partial<EarningRequest>;
    let amount: bigint;
    try {
      amount = toBaseUnits(String(body?.amount));
    } catch {
      throw new HttpError(400, "invalid_request", "`amount` must be a dollar string");
    }
    if (!body?.txHash || typeof body.txHash !== "string") throw new HttpError(400, "invalid_request", "`txHash` is required");
    if (!body.from || typeof body.from.origin !== "string") throw new HttpError(400, "invalid_request", "`from.origin` is required");
    // The payer's transfer receipt legitimately shares the hash; an earn receipt or any receipt of this agent does not.
    const hashKey = String(body.txHash).toLowerCase();
    if (recordingTx.has(hashKey) || store.state.receipts.some((r) => r.txHash?.toLowerCase() === hashKey && (r.kind === "earn" || r.agentId === agent.id))) {
      throw new HttpError(409, "duplicate_tx", "That transaction was already recorded");
    }
    recordingTx.add(hashKey); // claimed synchronously so concurrent reports of one payout cannot all pass
    try {
      const tx = await requireTx(body.txHash);
      if (tx !== "skip") {
        if (tx.kind === "mint" || tx.from.toLowerCase() === "0x0000000000000000000000000000000000000000") {
          throw new HttpError(400, "tx_mismatch", "That transaction is a mint, not a payout");
        }
        if (tx.to.toLowerCase() !== agent.address.toLowerCase() || String(tx.amountBaseUnits) !== amount.toString()) {
          throw new HttpError(400, "tx_mismatch", "That transaction does not pay this agent that amount");
        }
      }
    } catch (err) {
      recordingTx.delete(hashKey); // release the claim so a corrected report can succeed
      throw err;
    }
    const fromAddress = body.from.address && isAddress(body.from.address) ? getAddress(body.from.address) : ("0x0000000000000000000000000000000000000000" as Address);
    const receipt = newReceipt({
      kind: "earn",
      status: "settled",
      agentId: agent.id,
      agentName: agent.name,
      description: body.description || `Bounty${body.bountyId ? `: ${body.bountyId}` : ""}`,
      amount: toDollars(amount),
      amountBaseUnits: amount.toString(),
      counterparty: { address: fromAddress, origin: body.from.origin, name: body.from.name ?? hostOf(body.from.origin) },
      txHash: body.txHash as Hex,
      explorerUrl: explorerTxUrl(body.txHash, config.chainMode, config.facilitatorUrl),
      settledAt: nowIso(),
    });
    store.save();
    recordingTx.delete(hashKey);
    emit("earning.received", {
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} earned ${formatUsd(amount)} from ${receipt.counterparty.name ?? body.from.origin}.`,
      receipt,
      data: { bountyId: body.bountyId },
    });
    res.json({ receipt });
  });

  // GET /v1/receipts is shared: agent token → own receipts; otherwise owner → all (filter by agentId).
  router.get("/receipts", (req, res) => {
    const agent = agentFromRequest(req);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
    let receipts = store.state.receipts;
    if (agent) {
      receipts = receipts.filter((r) => r.agentId === agent.id);
    } else {
      if (config.ownerApiKey && req.header("x-owner-key") !== config.ownerApiKey) {
        throw new HttpError(401, "unauthorized", "X-Owner-Key or agent token required");
      }
      if (typeof req.query.agentId === "string") receipts = receipts.filter((r) => r.agentId === req.query.agentId);
    }
    res.json({ receipts: receipts.slice(-limit).reverse() });
  });

  // ---- services (agent + owner) --------------------------------------------

  router.get("/services", agentAuth, (req: AuthedRequest, res) => {
    res.json({ connected: req.agent!.services, directoryUrl: config.directoryUrl });
  });

  /** Agent token → `connected` flags; owner → `connectedAgents`. Same pattern as GET /v1/receipts. */
  function viewer(req: Request): StoredAgent | null {
    const agent = agentFromRequest(req);
    if (agent) return agent;
    if (config.ownerApiKey && req.header("x-owner-key") !== config.ownerApiKey) {
      throw new HttpError(401, "unauthorized", "X-Owner-Key or agent token required");
    }
    return null;
  }
  const isConnected = (agent: StoredAgent, id: string) => id === "directory" || agent.services.some((s) => s.id === id);
  const connectedAgents = (id: string) => store.state.agents.filter((a) => isConnected(a, id)).map((a) => a.id);
  const decorate = <T extends { id: string }>(agent: StoredAgent | null, s: T) =>
    agent ? { ...s, connected: isConnected(agent, s.id) } : { ...s, connectedAgents: connectedAgents(s.id) };

  router.get("/directory", async (req, res) => {
    const agent = viewer(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : undefined;
    const category = typeof req.query.category === "string" ? req.query.category.trim().slice(0, 40) : undefined;
    const services = await directoryCall(() => directory.list({ q, category }));
    res.json({ services: services.map(({ docs: _docs, ...s }) => decorate(agent, s)) });
  });

  router.get("/directory/:id", async (req, res) => {
    const agent = viewer(req);
    const id = String(req.params.id);
    // Custom services are not in the directory: the agent's own connection (or, for the owner, any) answers.
    const custom = (agent ? [agent] : store.state.agents)
      .flatMap((a) => a.services)
      .find((s) => s.id === id && s.source === "agent");
    if (custom) {
      res.json(decorate(agent, customManifest(custom)));
      return;
    }
    const manifest = await requireManifest(id);
    res.json(decorate(agent, manifest));
  });

  router.post("/services/requests", agentAuth, async (req: AuthedRequest, res) => {
    const agent = req.agent!;
    const body = (req.body ?? {}) as Partial<ServiceRequest>;
    if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Body must be { serviceId } or { custom }, plus reason");
    if (body.reason !== undefined && typeof body.reason !== "string") throw new HttpError(400, "invalid_request", "`reason` must be a string");
    const reason = body.reason?.trim().slice(0, 500) || undefined;
    const hasId = body.serviceId !== undefined && body.serviceId !== null;
    const hasCustom = body.custom !== undefined && body.custom !== null;
    if (hasId === hasCustom) throw new HttpError(400, "invalid_request", "Send either `serviceId` (a directory id) or `custom` (a proposal), not both");

    let grant: ServiceGrant;
    let docs: string | undefined;
    if (hasId) {
      if (typeof body.serviceId !== "string") throw new HttpError(400, "invalid_request", "`serviceId` must be a string");
      const id = body.serviceId.trim();
      const already = id === "directory" ? directoryConnection(agent) : agent.services.find((s) => s.id === id);
      if (already) {
        const out: ServiceRequestResponse = { status: "connected", service: already };
        res.json(out);
        return;
      }
      const manifest = await requireManifest(id);
      if (manifest.kind === "directory") {
        const out: ServiceRequestResponse = { status: "connected", service: directoryConnection(agent, manifest) };
        res.json(out);
        return;
      }
      grant = toGrant({ ...manifest, source: "directory" });
    } else {
      ({ grant, docs } = customGrant(agent, body.custom));
      const already = agent.services.find((s) => s.id === grant.id && s.baseUrl === grant.baseUrl);
      if (already) {
        const out: ServiceRequestResponse = { status: "connected", service: already };
        res.json(out);
        return;
      }
    }

    // One open request per service: asking again returns the same approval instead of a second card.
    const open = store.state.approvals.find(
      (a) => a.status === "pending" && a.kind === "service" && a.agentId === agent.id && a.service?.id === grant.id && a.service.baseUrl === grant.baseUrl,
    );
    const approval = open ?? openServiceApproval(agent, grant, reason, docs);
    const out: ServiceRequestResponse = {
      status: "needs_approval",
      approvalId: approval.id,
      service: approval.service!,
      message: `Waiting for your owner to approve connecting ${grant.name}. Approval id ${approval.id}.`,
    };
    res.status(202).json(out);
  });

  router.post("/agents/:id/services", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    const serviceId = req.body?.serviceId;
    if (typeof serviceId !== "string" || !serviceId.trim()) throw new HttpError(400, "invalid_request", "Body must be { serviceId }");
    const id = serviceId.trim();
    if (id !== "directory" && !agent.services.some((s) => s.id === id)) {
      const manifest = await requireManifest(id);
      if (manifest.kind !== "directory") connectService(agent, toGrant({ ...manifest, source: "directory" }), "owner");
    }
    res.json({ agent: await agentPublic(agent) });
  });

  router.delete("/agents/:id/services/:serviceId", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    const id = String(req.params.serviceId);
    const idx = agent.services.findIndex((s) => s.id === id);
    if (idx >= 0) {
      const [service] = agent.services.splice(idx, 1);
      store.save();
      emit("service.disconnected", {
        agentId: agent.id,
        agentName: agent.name,
        message: `${service.name} disconnected from ${agent.name}.`,
        data: { service, serviceId: service.id },
      });
    }
    res.json({ agent: await agentPublic(agent) });
  });

  // ---- owner endpoints -----------------------------------------------------

  router.post("/agents", ownerAuth, async (req, res) => {
    const body = req.body as Partial<CreateAgentRequest>;
    if (!body?.name || typeof body.name !== "string") throw new HttpError(400, "invalid_request", "`name` is required");
    if (!AGENT_NAME_RE.test(body.name)) {
      throw new HttpError(400, "invalid_request", "Agent names use lowercase letters, digits and dashes (2–32 characters), e.g. travel-planner");
    }
    if (store.agentByName(body.name)) throw new HttpError(409, "agent_exists", `An agent named "${body.name}" already exists`);
    // Resolve requested services before creating anything, so a bad id doesn't leave a half-made agent.
    const requested = Array.isArray(body.services) ? [...new Set(body.services.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))] : [];
    if (body.services !== undefined && !Array.isArray(body.services)) throw new HttpError(400, "invalid_request", "`services` must be an array of service ids");
    if (body.initialBalance !== undefined) {
      let units: bigint;
      try {
        units = toBaseUnits(String(body.initialBalance));
      } catch {
        throw new HttpError(400, "invalid_request", "`initialBalance` must be a dollar string");
      }
      if (units < 0n || units > toBaseUnits(MAX_TOPUP)) throw new HttpError(400, "invalid_request", `\`initialBalance\` must be between $0.00 and $${MAX_TOPUP}`);
    }
    const manifests = [];
    for (const id of requested) {
      if (id === "directory") continue;
      manifests.push(await requireManifest(id));
    }
    let created;
    try {
      created = createAgentOffline(store, { name: body.name, policy: body.policy, initialBalance: body.initialBalance });
    } catch (err) {
      throw new HttpError(400, "invalid_request", (err as Error).message);
    }
    const { stored, token, tokenId } = created;
    // Created first, then its services, so the owner's feed reads in the order things happened.
    emit("agent.created", { agentId: stored.id, agentName: stored.name, message: `Agent ${stored.name} created.`, data: { agent: await agentPublic(stored) } });
    for (const manifest of manifests) {
      if (manifest.kind !== "directory") connectService(stored, toGrant({ ...manifest, source: "directory" }), "owner");
    }
    if (config.chainMode === "mock" && stored.seedBalance && !stored.seedApplied) {
      try {
        const { txHash } = await mint(stored, stored.seedBalance);
        stored.seedApplied = true;
        store.save();
        recordTopup(stored, stored.seedBalance, txHash, "Starting balance");
      } catch (err) {
        console.warn(`${LOG} could not seed ${stored.name} now (${(err as Error).message}); will retry at next startup`);
      }
    }
    res.status(201).json({ agent: await agentPublic(stored), token, tokenId });
  });

  router.get("/agents", ownerAuth, async (_req, res) => {
    res.json({ agents: await Promise.all(store.state.agents.map(agentPublic)) });
  });

  router.get("/agents/:id", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    res.json({ agent: await agentPublic(agent), tokens: store.state.tokens.filter((t) => t.agentId === agent.id).map(publicToken) });
  });

  router.patch("/agents/:id/policy", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    const patch = (req.body ?? {}) as Partial<Policy>;
    try {
      agent.policy = normalizePolicy(agent.policy, patch);
    } catch (err) {
      throw new HttpError(400, "invalid_request", (err as Error).message);
    }
    if (!agent.policy.frozen) agent.frozenReason = undefined;
    store.save();
    emit("policy.updated", { agentId: agent.id, agentName: agent.name, message: `Policy updated for ${agent.name}.`, data: { patch: Object.keys(patch) } });
    res.json({ agent: await agentPublic(agent) });
  });

  router.post("/agents/:id/freeze", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    if (!agent.policy.frozen) {
      agent.policy.frozen = true;
      agent.frozenReason = "frozen by owner";
      store.save();
      emit("agent.frozen", { agentId: agent.id, agentName: agent.name, message: `${agent.name} frozen by owner.`, reason: "owner", data: { cause: "owner" } });
    }
    res.json({ agent: await agentPublic(agent) });
  });

  router.post("/agents/:id/unfreeze", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    if (agent.policy.frozen) {
      agent.policy.frozen = false;
      agent.frozenReason = undefined;
      store.save();
      emit("agent.unfrozen", { agentId: agent.id, agentName: agent.name, message: `${agent.name} unfrozen. It can spend again.` });
    }
    res.json({ agent: await agentPublic(agent) });
  });

  router.post("/agents/:id/tokens", ownerAuth, (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    const { token, stored } = issueToken(store, agent.id);
    store.save();
    res.status(201).json({ token, tokenId: stored.id });
  });

  router.delete("/agents/:id/tokens/:tokenId", ownerAuth, (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    const tok = store.state.tokens.find((t) => t.id === String(req.params.tokenId) && t.agentId === agent.id);
    if (!tok) throw new HttpError(404, "token_not_found", `No token ${String(req.params.tokenId)}`);
    if (!tok.revokedAt) {
      tok.revokedAt = nowIso();
      store.save();
      emit("token.revoked", { agentId: agent.id, agentName: agent.name, message: `A token for ${agent.name} was revoked.`, data: { tokenId: tok.id } });
    }
    res.json({ ok: true });
  });

  router.post("/agents/:id/topup", ownerAuth, async (req, res) => {
    const agent = requireAgentById(String(req.params.id));
    if (config.chainMode !== "mock") {
      throw new HttpError(501, "not_supported", "Top-ups are only available in mock mode; fund the address on Base Sepolia instead.");
    }
    let dollars: string;
    try {
      const units = toBaseUnits(String(req.body?.amount));
      if (units <= 0n || units > toBaseUnits(MAX_TOPUP)) throw new Error("range");
      dollars = toDollars(units);
    } catch {
      throw new HttpError(400, "invalid_request", `\`amount\` must be a dollar string between $0.01 and $${MAX_TOPUP}`);
    }
    let txHash: Hex;
    try {
      ({ txHash } = await mint(agent, dollars));
    } catch (err) {
      throw new HttpError(503, "ledger_unavailable", (err as Error).message);
    }
    res.json({ receipt: recordTopup(agent, dollars, txHash, "Top-up") });
  });

  router.get("/approvals", ownerAuth, (req, res) => {
    expireApprovals();
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const approvals = store.state.approvals.filter((a) => !status || a.status === status);
    res.json({ approvals: [...approvals].reverse() });
  });

  router.post("/approvals/:id/approve", ownerAuth, async (req, res) => {
    expireApprovals();
    const approval = store.approvalById(String(req.params.id));
    if (!approval) throw new HttpError(404, "approval_not_found", `No approval ${String(req.params.id)}`);
    if (approval.status !== "pending" || deciding.has(approval.id)) {
      throw new HttpError(409, "approval_not_pending", `Approval is already ${deciding.has(approval.id) ? "being decided" : approval.status}`);
    }
    const by = decidedBy(req.body?.by);
    deciding.add(approval.id);
    try {
      res.json({ approval: await settleApproval(approval, by) });
    } finally {
      deciding.delete(approval.id);
    }
  });

  router.post("/approvals/:id/deny", ownerAuth, (req, res) => {
    expireApprovals();
    const approval = store.approvalById(String(req.params.id));
    if (!approval) throw new HttpError(404, "approval_not_found", `No approval ${String(req.params.id)}`);
    if (approval.status !== "pending" || deciding.has(approval.id)) {
      throw new HttpError(409, "approval_not_pending", `Approval is already ${deciding.has(approval.id) ? "being decided" : approval.status}`);
    }
    const by = decidedBy(req.body?.by);
    approval.status = "denied";
    approval.decidedAt = nowIso();
    approval.decidedBy = by;
    const receipt = store.state.receipts.find((r) => r.approvalId === approval.id);
    if (receipt) {
      receipt.status = "denied";
      receipt.reason = "denied_by_owner";
    }
    if (approval.paymentId) delete store.state.pendingPayments[approval.paymentId];
    delete store.state.serviceRequests[approval.id];
    store.save();
    emit("approval.denied", {
      agentId: approval.agentId,
      agentName: approval.agentName,
      message:
        approval.kind === "service"
          ? `Denied by ${by}: ${approval.service?.name ?? "the service"} will not be connected to ${approval.agentName}.`
          : `Denied by ${by}: ${approval.agentName} will not pay ${formatUsd(toBaseUnits(approval.amount))} to ${approval.counterparty.name ?? approval.counterparty.origin ?? "that address"}.`,
      reason: "denied_by_owner",
      approval,
      receipt,
    });
    bus.emit(`approval:${approval.id}`, approval);
    res.json({ approval });
  });

  router.get("/events/recent", ownerAuth, (req, res) => {
    const limit = Math.min(MAX_EVENTS, Math.max(1, Number(req.query.limit ?? 100) || 100));
    res.json({ events: store.state.events.slice(-limit) });
  });

  router.get("/events", ownerAuth, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected ${nowIso()}\n\n`);
    sseClients.add(res);
    const onEvent = (e: WalletEvent) => {
      res.write(`event: ${e.type}\nid: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const ping = setInterval(() => res.write(`: ping\n\n`), SSE_PING_MS);
    bus.on("event", onEvent);
    req.on("close", () => {
      clearInterval(ping);
      bus.off("event", onEvent);
      sseClients.delete(res);
    });
  });

  router.post("/reset", ownerAuth, (_req, res) => {
    store.state.receipts = [];
    store.state.approvals = [];
    store.state.events = [];
    store.state.pendingPayments = {};
    store.state.serviceRequests = {};
    store.save();
    console.log(`${LOG} reset: receipts, approvals and events cleared`);
    res.json({ ok: true });
  });

  // ---- errors --------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `No route ${req.method} ${req.path}` });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    const e = err as { status?: number; type?: string; message?: string };
    if (e?.type === "entity.parse.failed" || e?.status === 400) {
      res.status(400).json({ error: "invalid_json", message: "Request body must be valid JSON" });
      return;
    }
    console.error(`${LOG} unhandled error:`, e?.message ?? err);
    res.status(500).json({ error: "internal", message: e?.message ?? "Internal error" });
  });

  const expiryTimer = setInterval(expireApprovals, 10_000);
  expiryTimer.unref();

  return {
    app,
    store,
    settlement,
    bus,
    telegramConnected: () => telegramConnected,
    seedBalances,
    close: () => {
      clearInterval(expiryTimer);
      for (const res of sseClients) res.end();
      sseClients.clear();
    },
  };
}

/** The grant fields of a manifest or connection (what an approval card shows and a connection stores). */
function toGrant(s: ServiceGrant): ServiceGrant {
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    icon: s.icon,
    color: s.color,
    kind: s.kind,
    category: s.category ?? "tools",
    summary: s.summary,
    baseUrl: s.baseUrl,
    pricing: s.pricing,
    maxPrice: s.maxPrice,
    permissions: [...(s.permissions ?? [])],
    source: s.source ?? "directory",
  };
}

function decidedBy(v: unknown): string {
  return v === "telegram" || v === "dashboard" || v === "auto" ? v : "dashboard";
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

