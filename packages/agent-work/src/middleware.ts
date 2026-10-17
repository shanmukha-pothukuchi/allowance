import express, { type NextFunction, type Request, type Response, type Router } from "express";
import {
  BASE_SEPOLIA_NETWORK,
  nowIso,
  toBaseUnits,
  type Address,
  type AgentWorkDoc,
  type AgentWorkError,
  type AgentWorkErrorCode,
  type BountyDoc,
  type ClaimResponse,
  type Hex,
  type PayoutResponse,
} from "@allowance/shared";
import { BountyStore, normalizeAddress, type BountyConfig, type Claim } from "./store.js";
import { PAYOUT_RESPONSE_HEADER, encodePayoutResponseHeader } from "./header.js";
import { renderBoard } from "./board.js";

export const WELL_KNOWN_PATH = "/.well-known/agent-work";
export const LINK_HEADER_VALUE = `<${WELL_KNOWN_PATH}>; rel="agent-work"`;

export type VerifyResult = { ok: true } | { ok: false; message: string; details?: unknown };

export type AgentWorkEventType = "claimed" | "expired" | "submitted" | "rejected" | "paid" | "payout_failed";

export interface AgentWorkEvent {
  type: AgentWorkEventType;
  bountyId: string;
  claimId?: string;
  walletAddress?: Address;
  agentName?: string;
  at: string;
  /** Slot counts for the bounty right after this event. */
  slots: { total: number; remaining: number };
  /** paid only. */
  amount?: string;
  txHash?: Hex;
  explorerUrl?: string;
  /** rejected / payout_failed. */
  message?: string;
}

export interface AgentWorkOptions {
  site: { name: string; url: string };
  bounties: BountyConfig[];
  /** Verify submitted work by code. Must be deterministic for the same result. */
  verify: (bountyId: string, result: unknown, claim: Claim) => Promise<VerifyResult>;
  /** Pay `amountBaseUnits` of USDC to `to`. Called at most once per claim unless it throws. */
  payout: (
    to: Address,
    amountBaseUnits: bigint,
    ctx: { bountyId: string; claimId: string },
  ) => Promise<{ txHash: Hex; explorerUrl?: string }>;
  /** Mount point for claim/submit/events. Default "/agent-work". */
  basePath?: string;
  /** CAIP-2 network id. Default "eip155:84532". */
  network?: string;
  onEvent?: (e: AgentWorkEvent) => void;
  /** Sweep interval for expiring claims, ms. Default 1000. */
  sweepIntervalMs?: number;
}

export interface AgentWorkRouter extends Router {
  store: BountyStore;
  /** Current protocol document. */
  doc(): AgentWorkDoc;
  /** Stop the sweep timer and close SSE clients. */
  close(): void;
}

/** Sets `Link: </.well-known/agent-work>; rel="agent-work"` on every response. Mount globally. */
export function agentWorkLinkHeader() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Link", LINK_HEADER_VALUE);
    next();
  };
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/html");
}

function normalizeBasePath(p: string | undefined): string {
  let out = (p ?? "/agent-work").trim();
  if (!out.startsWith("/")) out = `/${out}`;
  out = out.replace(/\/+$/, "");
  return out || "/agent-work";
}

export function agentWork(options: AgentWorkOptions): AgentWorkRouter {
  const basePath = normalizeBasePath(options.basePath);
  const siteUrl = options.site.url.replace(/\/+$/, "");
  const network = options.network ?? BASE_SEPOLIA_NETWORK;
  const sseClients = new Set<Response>();

  const emit = (e: AgentWorkEvent) => {
    try {
      options.onEvent?.(e);
    } catch (err) {
      console.error("[agent-work] onEvent threw:", err);
    }
    const frame = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const res of sseClients) res.write(frame);
  };

  const store = new BountyStore(options.bounties, {
    onExpire: (c) =>
      emit({
        type: "expired",
        bountyId: c.bountyId,
        claimId: c.claimId,
        walletAddress: c.walletAddress,
        agentName: c.agentName,
        at: nowIso(),
        slots: slotsOf(c.bountyId),
      }),
  });

  function slotsOf(bountyId: string) {
    return { total: store.getBounty(bountyId)?.slots ?? 0, remaining: store.remaining(bountyId) };
  }

  function bountyDoc(b: BountyConfig): BountyDoc {
    return {
      id: b.id,
      title: b.title,
      description: b.description,
      taskType: b.taskType,
      input: b.input,
      payout: { amount: store.payoutAmount(b.id), asset: "USDC", network },
      slots: slotsOf(b.id),
      claimTtlSeconds: store.ttlSeconds(b.id),
      claimUrl: `${siteUrl}${basePath}/bounties/${encodeURIComponent(b.id)}/claim`,
      submitUrl: `${siteUrl}${basePath}/bounties/${encodeURIComponent(b.id)}/submit`,
      verification: b.verification,
      status: store.status(b.id),
    };
  }

  function doc(): AgentWorkDoc {
    return {
      protocol: "agent-work",
      version: "0.1",
      site: { name: options.site.name, url: siteUrl },
      bounties: store.listBounties().map(bountyDoc),
    };
  }

  const sweep = setInterval(() => store.sweep(), options.sweepIntervalMs ?? 1000);
  sweep.unref?.();

  const router = express.Router() as AgentWorkRouter;
  router.store = store;
  router.doc = doc;
  router.close = () => {
    clearInterval(sweep);
    for (const res of sseClients) res.end();
    sseClients.clear();
  };

  // Every response that passes through this router carries the discovery link.
  router.use(agentWorkLinkHeader());

  const common = (res: Response) => {
    res.setHeader("Vary", "Accept");
    res.setHeader("Cache-Control", "no-store");
  };

  const sendError = (res: Response, status: number, error: AgentWorkErrorCode, message: string, details?: unknown) => {
    common(res);
    const body: AgentWorkError = details === undefined ? { error, message } : { error, message, details };
    res.status(status).json(body);
  };

  // --- Discovery -----------------------------------------------------------------------------
  router.get(WELL_KNOWN_PATH, (req, res) => {
    common(res);
    res.setHeader("Access-Control-Allow-Origin", "*");
    const d = doc();
    if (wantsHtml(req)) {
      res.type("html").send(renderBoard({ doc: d, basePath, wellKnownPath: WELL_KNOWN_PATH }));
    } else {
      res.json(d);
    }
  });

  // --- Live events (SSE) ---------------------------------------------------------------------
  router.get(`${basePath}/events`, (req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(doc())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  // --- Claim ---------------------------------------------------------------------------------
  router.post(`${basePath}/bounties/:id/claim`, express.json({ limit: "64kb" }), (req, res) => {
    const bountyId = String(req.params.id);
    const body = (req.body ?? {}) as { walletAddress?: unknown; agentName?: unknown };
    const wallet = normalizeAddress(body.walletAddress);
    if (!wallet) return sendError(res, 400, "invalid_request", "walletAddress must be a 0x-prefixed EVM address.");
    const agentName = typeof body.agentName === "string" ? body.agentName.slice(0, 64) : undefined;

    const result = store.tryClaim(bountyId, wallet, agentName);
    if (!result.ok) {
      const status = result.code === "bounty_not_found" ? 404 : 409;
      return sendError(res, status, result.code, result.message);
    }
    const claim = result.claim;
    const bounty = store.getBounty(bountyId)!;
    emit({
      type: "claimed",
      bountyId,
      claimId: claim.claimId,
      walletAddress: claim.walletAddress,
      agentName: claim.agentName,
      at: nowIso(),
      slots: slotsOf(bountyId),
    });
    const response: ClaimResponse = {
      claimId: claim.claimId,
      bountyId,
      walletAddress: claim.walletAddress,
      expiresAt: new Date(claim.expiresAt).toISOString(),
      submitUrl: `${siteUrl}${basePath}/bounties/${encodeURIComponent(bountyId)}/submit`,
      input: bounty.input,
    };
    common(res);
    res.status(201).json(response);
  });

  // --- Submit --------------------------------------------------------------------------------
  const chains = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  type SubmitOutcome = { status: number; body: AgentWorkError | PayoutResponse };

  async function processSubmit(bountyId: string, claimId: string, result: unknown): Promise<SubmitOutcome> {
    const claim = store.getClaim(claimId)!;
    if (claim.status === "paid" && claim.payout) return { status: 200, body: claim.payout };
    if (claim.status === "expired") {
      return { status: 410, body: { error: "claim_expired", message: "The claim expired before submission. Claim again if slots remain." } };
    }
    store.setBusy(claimId, true);
    try {
      const base = { bountyId, claimId, walletAddress: claim.walletAddress, agentName: claim.agentName };
      emit({ type: "submitted", ...base, at: nowIso(), slots: slotsOf(bountyId) });

      let verdict: VerifyResult;
      try {
        verdict = await options.verify(bountyId, result, claim);
      } catch (err) {
        verdict = { ok: false, message: `Verification error: ${(err as Error)?.message ?? String(err)}` };
      }
      if (!verdict.ok) {
        emit({ type: "rejected", ...base, at: nowIso(), slots: slotsOf(bountyId), message: verdict.message });
        return {
          status: 422,
          body: verdict.details === undefined
            ? { error: "rejected", message: verdict.message }
            : { error: "rejected", message: verdict.message, details: verdict.details },
        };
      }

      const amount = store.payoutAmount(bountyId);
      const amountBaseUnits = toBaseUnits(amount);
      store.markPaying(claimId);
      let tx: { txHash: Hex; explorerUrl?: string };
      try {
        tx = await options.payout(claim.walletAddress, amountBaseUnits, { bountyId, claimId });
        if (!tx || typeof tx.txHash !== "string") throw new Error("payout() returned no txHash");
      } catch (err) {
        store.revertToClaimed(claimId);
        const message = (err as Error)?.message ?? String(err);
        emit({ type: "payout_failed", ...base, at: nowIso(), slots: slotsOf(bountyId), message });
        return { status: 502, body: { error: "payout_failed", message: `Work accepted but payment failed: ${message}` } };
      }

      const payout: PayoutResponse = {
        status: "paid",
        claimId,
        bountyId,
        amount,
        asset: "USDC",
        network,
        to: claim.walletAddress,
        txHash: tx.txHash,
        ...(tx.explorerUrl ? { explorerUrl: tx.explorerUrl } : {}),
        paidAt: nowIso(),
      };
      store.markPaid(claimId, payout);
      emit({
        type: "paid",
        ...base,
        at: payout.paidAt,
        slots: slotsOf(bountyId),
        amount,
        txHash: tx.txHash,
        explorerUrl: tx.explorerUrl,
      });
      return { status: 200, body: payout };
    } finally {
      store.setBusy(claimId, false);
    }
  }

  router.post(`${basePath}/bounties/:id/submit`, express.json({ limit: "1mb" }), async (req, res, next) => {
    try {
      const bountyId = String(req.params.id);
      const body = (req.body ?? {}) as { claimId?: unknown; walletAddress?: unknown; result?: unknown };
      const wallet = normalizeAddress(body.walletAddress);
      if (typeof body.claimId !== "string" || !body.claimId) {
        return sendError(res, 400, "invalid_request", "claimId is required.");
      }
      if (!wallet) return sendError(res, 400, "invalid_request", "walletAddress must be a 0x-prefixed EVM address.");
      if (!store.getBounty(bountyId)) return sendError(res, 404, "bounty_not_found", `No bounty with id "${bountyId}".`);

      const claim = store.getClaim(body.claimId);
      if (!claim || claim.bountyId !== bountyId || claim.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
        return sendError(res, 404, "claim_not_found", "Unknown claimId, or it does not belong to this wallet and bounty.");
      }

      const outcome = await serialized(claim.claimId, () => processSubmit(bountyId, claim.claimId, body.result));
      common(res);
      if (outcome.status === 200) {
        res.setHeader(PAYOUT_RESPONSE_HEADER, encodePayoutResponseHeader(outcome.body as PayoutResponse));
      }
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      next(err);
    }
  });

  // --- Errors (bad JSON etc.) ----------------------------------------------------------------
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed" || e?.status === 400 || e?.status === 413 || e?.status === 415) {
      return sendError(res, e.status === 413 ? 413 : 400, "invalid_request", e.message ?? "Malformed JSON body.");
    }
    console.error("[agent-work] unhandled error:", err);
    res.status(500).json({ error: "internal_error", message: "Internal error." });
  });

  return router;
}
