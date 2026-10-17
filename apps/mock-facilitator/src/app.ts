/**
 * Mock x402 facilitator (CHAIN_MODE=mock). Implements the facilitator HTTP interface that
 * `HTTPFacilitatorClient` from @x402/core calls (`/supported`, `/verify`, `/settle`) plus
 * admin/ledger endpoints and a tiny explorer. See docs/ARCHITECTURE.md §5.
 */
import express, { type Express, type Request, type Response } from "express";
import { getAddress, isAddress, type Address } from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type AppConfig, BASE_SEPOLIA_NETWORK, toBaseUnits, toDollars } from "@allowance/shared";
import { Ledger } from "./ledger.js";
import { LedgerExactEvmFacilitator } from "./scheme.js";
import { explorerPage, txPage, notFoundPage } from "./explorer.js";

export interface FacilitatorAppOptions {
  /** Silence per-request logging (tests). */
  quiet?: boolean;
  /** Clock override for tests (unix seconds). */
  now?: () => number;
}

/** The facilitator's "signer" address: purely cosmetic in mock mode (no chain). */
export const MOCK_FACILITATOR_SIGNER: Address = "0xFAC1117A70000000000000000000000000000001";

export interface FacilitatorApp extends Express {
  locals: Express["locals"] & { ledger: Ledger };
}

function wantsHtml(req: Request): boolean {
  return (req.headers.accept ?? "").includes("text/html");
}

function badRequest(res: Response, message: string, extra: Record<string, unknown> = {}) {
  res.status(400).json({ error: "invalid_request", message, ...extra });
}

export function createFacilitatorApp(config: AppConfig, opts: FacilitatorAppOptions = {}): FacilitatorApp {
  const ledger = new Ledger(config.dataDir);
  const scheme = new LedgerExactEvmFacilitator(ledger, MOCK_FACILITATOR_SIGNER, opts.now);
  const facilitator = new x402Facilitator().register(BASE_SEPOLIA_NETWORK, scheme);
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`[facilitator] ${msg}`);

  const app = express() as FacilitatorApp;
  app.locals.ledger = ledger;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // One line per mutating request; GETs are polled by the explorer and stay quiet.
  app.use((req, res, next) => {
    if (req.method !== "GET") {
      res.on("finish", () => log(`${req.method} ${req.path} -> ${res.statusCode}`));
    }
    next();
  });

  // ---- x402 facilitator interface -------------------------------------------

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  function parseX402Body(req: Request): { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | string {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") return "JSON body required";
    const paymentPayload = b.paymentPayload as PaymentPayload | undefined;
    const paymentRequirements = b.paymentRequirements as PaymentRequirements | undefined;
    if (!paymentPayload || typeof paymentPayload !== "object") return "paymentPayload required";
    if (!paymentRequirements || typeof paymentRequirements !== "object") return "paymentRequirements required";
    if (paymentPayload.x402Version !== 2) return `unsupported x402Version ${String(paymentPayload.x402Version)}`;
    return { paymentPayload, paymentRequirements };
  }

  app.post("/verify", async (req, res) => {
    const parsed = parseX402Body(req);
    if (typeof parsed === "string") {
      res.status(400).json({ isValid: false, invalidReason: "invalid_request", invalidMessage: parsed });
      return;
    }
    try {
      const result = await facilitator.verify(parsed.paymentPayload, parsed.paymentRequirements);
      log(`verify ${result.isValid ? "ok" : `rejected (${result.invalidReason})`} payer=${result.payer ?? "?"}`);
      res.json(result);
    } catch (err) {
      res.status(400).json({ isValid: false, invalidReason: "unsupported", invalidMessage: (err as Error).message });
    }
  });

  app.post("/settle", async (req, res) => {
    const parsed = parseX402Body(req);
    if (typeof parsed === "string") {
      res.status(400).json({ success: false, errorReason: "invalid_request", errorMessage: parsed, transaction: "", network: BASE_SEPOLIA_NETWORK });
      return;
    }
    try {
      const result = await facilitator.settle(parsed.paymentPayload, parsed.paymentRequirements);
      if (result.success) {
        const tx = ledger.getTx(result.transaction);
        log(`settle ok $${tx?.amount ?? "?"} ${tx?.from ?? "?"} -> ${tx?.to ?? "?"} tx=${result.transaction}`);
      } else {
        log(`settle rejected (${result.errorReason}) payer=${result.payer ?? "?"}`);
      }
      // Replays and other rejections come back as HTTP 200 with success:false; the x402
      // client understands that shape and turns it into a 402 for the agent.
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, errorReason: "unsupported", errorMessage: (err as Error).message, transaction: "", network: BASE_SEPOLIA_NETWORK });
    }
  });

  // ---- ledger ---------------------------------------------------------------

  app.get("/balance/:address", (req, res) => {
    const { address } = req.params as { address: string };
    if (!isAddress(address)) return badRequest(res, "invalid address");
    const bal = ledger.balanceOf(address);
    res.json({ address: getAddress(address), balanceBaseUnits: bal.toString(), balance: toDollars(bal) });
  });

  /** Additive helper for the explorer page (not in §5; harmless). */
  app.get("/balances", (_req, res) => {
    res.json({ balances: ledger.allBalances() });
  });

  app.post("/admin/mint", (req, res) => {
    const { to, amount, memo } = (req.body ?? {}) as { to?: string; amount?: string; memo?: string };
    if (!to || !isAddress(to)) return badRequest(res, "`to` must be an address");
    let units: bigint;
    try {
      units = toBaseUnits(amount ?? "");
    } catch (err) {
      return badRequest(res, (err as Error).message);
    }
    if (units <= 0n) return badRequest(res, "amount must be positive");
    const tx = ledger.mint(to, units, memo);
    log(`mint $${tx.amount} -> ${tx.to} tx=${tx.hash}`);
    res.json({ txHash: tx.hash, balance: toDollars(ledger.balanceOf(to)) });
  });

  app.post("/admin/transfer", (req, res) => {
    const { from, to, amount, memo } = (req.body ?? {}) as { from?: string; to?: string; amount?: string; memo?: string };
    if (!from || !isAddress(from)) return badRequest(res, "`from` must be an address");
    if (!to || !isAddress(to)) return badRequest(res, "`to` must be an address");
    let units: bigint;
    try {
      units = toBaseUnits(amount ?? "");
    } catch (err) {
      return badRequest(res, (err as Error).message);
    }
    if (units <= 0n) return badRequest(res, "amount must be positive");
    try {
      const tx = ledger.transfer(from, to, units, memo);
      log(`transfer $${tx.amount} ${tx.from} -> ${tx.to} tx=${tx.hash}`);
      res.json({ txHash: tx.hash });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "insufficient_funds" ? 400 : 500).json({ error: message, message });
    }
  });

  app.post("/admin/reset", (_req, res) => {
    ledger.reset();
    log("ledger reset");
    res.json({ ok: true });
  });

  app.get("/txs", (req, res) => {
    const address = typeof req.query.address === "string" ? req.query.address : undefined;
    if (address && !isAddress(address)) return badRequest(res, "invalid address");
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ txs: ledger.listTxs({ address, limit: Number.isFinite(limit) ? limit : undefined }) });
  });

  app.get("/tx/:hash", (req, res) => {
    const { hash } = req.params as { hash: string };
    const tx = ledger.getTx(hash);
    if (wantsHtml(req)) {
      res.setHeader("Vary", "Accept");
      res.status(tx ? 200 : 404).type("html").send(tx ? txPage(tx) : notFoundPage(hash));
      return;
    }
    res.setHeader("Vary", "Accept");
    if (!tx) {
      res.status(404).json({ error: "tx_not_found", message: `no transaction ${hash}` });
      return;
    }
    res.json(tx);
  });

  app.get("/explorer", (_req, res) => {
    res.type("html").send(explorerPage());
  });

  app.get("/", (_req, res) => res.redirect("/explorer"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: "mock", accounts: ledger.accountCount(), txs: ledger.listTxs({ limit: 500 }).length });
  });

  // JSON 404 + error handler so the facilitator never returns Express HTML.
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `${req.method} ${req.path}` });
  });
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: "internal_error", message: err.message });
  });

  return app;
}
