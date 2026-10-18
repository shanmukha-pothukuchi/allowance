/**
 * Quantcomm bridge (docs/ARCHITECTURE.md §17.1): Quantcomm's flood and bank research, sold to agents
 * per request over x402. Quantcomm (the sibling repo ../technica2026) is read with GET only; the bridge
 * never calls `POST /api/advice/run`.
 *
 * - `GET /quantcomm` (free): the companies Quantcomm covers and what each paid endpoint returns.
 * - `GET /quantcomm/alerts` ($0.05), `/quantcomm/companies/:ticker/flood` ($0.05),
 *   `/quantcomm/companies/:ticker/view` ($0.10): compact research, paid to Quantcomm's earnings wallet.
 *
 * Never charged for a failure. Each paid route builds its whole answer from Quantcomm *before* the
 * paywall: Quantcomm down (503), a ticker it doesn't cover (404) or a changed API (502) answer without
 * a 402. After payment the handler only sends what was built. `@x402/express` (2.28) settles only when
 * the handler's status is < 400, so a payment is settled exactly when the research is delivered.
 */
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { BASE_SEPOLIA_NETWORK, explorerTxUrl, toDollars, type AppConfig } from "@allowance/shared";
import {
  alertsBlock,
  capitalOneBlock,
  compactPanel,
  isPanelKey,
  MAX_TOP_BANKS,
  missingNote,
  SOURCE,
  topBanks,
  viewBody,
  type AlertsBlock,
  type CapitalOneBlock,
  type ViewBody,
} from "./compact.js";
import { CHANGED, changed, HttpError, isQuantcommError, QuantcommError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { analystStatus, isMissing, panelWhere, readAlertOverview, readAnalysis, readBanks, readNessieAlerts, type Markets } from "./shapes.js";
import { createQuantcommClient, type QuantcommClient } from "./upstream.js";
import { loadEarningsAccount } from "./wallet.js";

export type QuantcommBridgeConfig = Pick<AppConfig, "dataDir" | "quantcommUrl" | "quantcommBridgeUrl" | "x402FacilitatorUrl" | "chainMode" | "facilitatorUrl">;

export interface QuantcommBridgeDeps {
  /** fetch for Quantcomm (tests point it at a stub). The facilitator uses global fetch. */
  fetch?: FetchLike;
  /** The earnings (payTo) wallet; defaults to DATA_DIR/quantcomm-bridge-key.json. */
  account?: { address: `0x${string}` };
  /** ms clock (cache and alert age). */
  now?: () => number;
  quiet?: boolean;
  /** Upstream cache lifetime (default 60 s). */
  cacheTtlMs?: number;
  /** How often to retry a facilitator that isn't up yet (default 2 s). */
  facilitatorRetryMs?: number;
}

export interface QuantcommBridgeApp extends Express {
  locals: Express["locals"] & {
    payTo: `0x${string}`;
    upstream: QuantcommClient;
  };
}

/** What the paywall charges, dollars. */
export const PRICES = { alerts: "0.05", flood: "0.05", view: "0.10" } as const;
/** The 402's resource description: receipts and the Capital One statement name the merchant by it. */
export const SERVICE_NAME = "Quantcomm Flood Research";
export const PROVIDER = "Quantcomm";
/** Quantcomm's own Capital One ticker (the branch_map panel's company). */
const CAPITAL_ONE = "COF";
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export interface AlertsBody {
  asOf: string | null;
  ageHours: number | null;
  alerts: AlertsBlock["alerts"];
  activeStorms: AlertsBlock["activeStorms"];
  banksUnderAlerts: { count: number; top: ReturnType<typeof topBanks> } | null;
  capitalOne: CapitalOneBlock | null;
  source: string;
  note?: string;
}

export interface FloodBody {
  ticker: string;
  name: string;
  asOf: string | null;
  panels: Record<string, Record<string, unknown> | null>;
  note?: string;
}

export function createQuantcommBridgeApp(config: QuantcommBridgeConfig, deps: QuantcommBridgeDeps = {}): QuantcommBridgeApp {
  const log = deps.quiet ? () => {} : (msg: string) => console.log(`[quantcomm] ${msg}`);
  const warn = deps.quiet ? () => {} : (msg: string) => console.warn(`[quantcomm] ${msg}`);
  const now = deps.now ?? Date.now;
  const payTo = deps.account?.address ?? loadEarningsAccount(config.dataDir, log).address;
  const bridgeUrl = config.quantcommBridgeUrl.replace(/\/+$/, "");
  const upstream = createQuantcommClient({ baseUrl: config.quantcommUrl, fetch: deps.fetch, now, ttlMs: deps.cacheTtlMs });

  // ---- research (built before the paywall) ------------------------------------------------------------

  const normalizeTicker = (raw: string) => raw.trim().toUpperCase();

  /** Universe tickers that offer at least one research panel (probes are cached). */
  async function floodCovered(m: Markets): Promise<string[]> {
    const opts = await Promise.all(m.universe.map((t) => upstream.options(t)));
    return m.universe.filter((_t, i) => (opts[i]?.length ?? 0) > 0);
  }

  async function buildIndex() {
    const [m, advice] = await Promise.all([upstream.markets(), upstream.advice()]);
    const companies = [];
    for (const t of m.universe) {
      const opts = await upstream.options(t);
      if (!opts) throw changed(`research ${t}: Quantcomm lists ${t} in its universe but answers 404 for its research`);
      const c = m.companies.get(t)!;
      companies.push({ ticker: t, name: c.name, group: c.group, analystView: analystStatus(advice, t) === "ok", research: opts.map((o) => o.key) });
    }
    const ex = companies.find((c) => c.research.length) ?? companies[0];
    return {
      name: SERVICE_NAME,
      provider: PROVIDER,
      asOf: m.asOf,
      companies,
      endpoints: [
        { method: "GET", url: `${bridgeUrl}/quantcomm/alerts`, price: `$${PRICES.alerts}`, returns: "Live NWS flood alerts by type, active storms, the banks with the most deposits under those alerts, and Capital One's sandbox branches and ATMs under them." },
        { method: "GET", url: `${bridgeUrl}/quantcomm/companies/{ticker}/flood`, example: `${bridgeUrl}/quantcomm/companies/${ex.ticker}/flood`, price: `$${PRICES.flood}`, returns: "One company's flood research: the panels listed under its research." },
        { method: "GET", url: `${bridgeUrl}/quantcomm/companies/{ticker}/view`, example: `${bridgeUrl}/quantcomm/companies/${ex.ticker}/view`, price: `$${PRICES.view}`, returns: "Quantcomm's AI analyst view of one company (companies with analystView true): view, confidence, reasoning, evidence and data gaps." },
      ],
      caveats: [
        "Capital One locations are Capital One's Nessie sandbox branches and ATMs (MD/VA/DC), not its real network.",
        "Capital One customers in the stress test are SYNTHETIC.",
        "Alerts carry their age; old alerts say so.",
        "Analyst views are research, not financial advice.",
      ],
    };
  }

  async function buildAlerts(): Promise<AlertsBody> {
    const m = await upstream.markets();
    // The overview and bank rows: alerts_map and alert_exposure of the first universe company that offers both.
    let source: string | undefined;
    for (const t of m.universe) {
      const keys = (await upstream.options(t))?.map((o) => o.key) ?? [];
      if (keys.includes("alerts_map") && keys.includes("alert_exposure")) {
        source = t;
        break;
      }
    }
    if (!source) throw changed("research: no company in Quantcomm's universe offers the alerts_map and alert_exposure panels");
    const r = await upstream.research(source, ["alerts_map", "alert_exposure"]);
    if (!r) throw changed(`research ${source}: alerts_map and alert_exposure answered 404`);
    const overview = readAlertOverview(r.panels.alerts_map.alerts, `${panelWhere(source, "alerts_map")}.alerts`);
    if (isMissing(overview)) throw new QuantcommError("unavailable", "Quantcomm has no live flood-alert data right now (its live run hasn't produced it); nothing was charged.");
    const block = alertsBlock(overview, now());
    const notes = block.note ? [block.note] : [];

    const banks = readBanks(r.panels.alert_exposure.banks, `${panelWhere(source, "alert_exposure")}.banks`);
    if (isMissing(banks)) notes.push(missingNote(banks, "bank deposits under alerts"));

    let capitalOne: CapitalOneBlock | null = null;
    const cofKeys = m.universe.includes(CAPITAL_ONE) ? ((await upstream.options(CAPITAL_ONE))?.map((o) => o.key) ?? []) : [];
    if (cofKeys.includes("branch_map")) {
      const cof = await upstream.research(CAPITAL_ONE, ["branch_map"]);
      if (!cof) throw changed(`research ${CAPITAL_ONE}: branch_map answered 404`);
      const nessie = readNessieAlerts(cof.panels.branch_map.nessie, `${panelWhere(CAPITAL_ONE, "branch_map")}.nessie`);
      if (isMissing(nessie)) notes.push(missingNote(nessie, "Capital One's branch and ATM check"));
      else capitalOne = capitalOneBlock(nessie);
    } else {
      notes.push("Quantcomm didn't return Capital One's branch and ATM check.");
    }

    return {
      asOf: block.asOf,
      ageHours: block.ageHours,
      alerts: block.alerts,
      activeStorms: block.activeStorms,
      banksUnderAlerts: isMissing(banks) ? null : { count: banks.count, top: topBanks(banks.rows, MAX_TOP_BANKS) },
      capitalOne,
      source: SOURCE,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }

  async function buildFlood(raw: string): Promise<FloodBody> {
    const m = await upstream.markets();
    const ticker = normalizeTicker(raw);
    const notCovered = async (message: string) => {
      const covered = await floodCovered(m);
      return new HttpError(404, "ticker_not_covered", `${message} Flood research covers: ${covered.join(", ")}.`, { ticker, covered });
    };
    if (!TICKER_RE.test(ticker) || !m.universe.includes(ticker)) throw await notCovered(`Quantcomm doesn't cover ${ticker.slice(0, 12) || "that ticker"}.`);
    const r = await upstream.research(ticker);
    if (!r) throw changed(`research ${ticker}: Quantcomm lists ${ticker} in its universe but answers 404 for its research`);
    const name = m.companies.get(ticker)!.name;
    if (!r.options.length) throw await notCovered(`Quantcomm has no flood research for ${ticker} (${name}).`);

    const t = now();
    const panels: FloodBody["panels"] = {};
    const notes: string[] = [];
    for (const { key, title } of r.options) {
      if (!isPanelKey(key)) {
        notes.push(`Quantcomm also offers "${title}" (${key}), which the bridge doesn't read yet.`);
        continue;
      }
      const p = compactPanel(key, r.panels[key], panelWhere(ticker, key), t);
      panels[key] = p.value;
      for (const n of p.notes) if (!notes.includes(n)) notes.push(n);
    }
    if (!Object.values(panels).some((v) => v !== null)) {
      throw new QuantcommError("unavailable", `Quantcomm hasn't produced ${ticker}'s flood research yet; nothing was charged.`);
    }
    return { ticker, name: r.name, asOf: r.asOf, panels, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  async function buildView(raw: string): Promise<ViewBody> {
    const [m, advice] = await Promise.all([upstream.markets(), upstream.advice()]);
    const ticker = normalizeTicker(raw);
    const withViews = m.universe.filter((t) => analystStatus(advice, t) === "ok");
    if (!TICKER_RE.test(ticker) || !m.universe.includes(ticker)) {
      throw new HttpError(404, "ticker_not_covered", `Quantcomm doesn't cover ${ticker.slice(0, 12) || "that ticker"}. Analyst views cover: ${withViews.join(", ") || "none yet"}.`, { ticker, covered: withViews });
    }
    if (!advice.available) {
      throw new HttpError(404, "no_analyst_view", "Quantcomm hasn't generated analyst views yet.", { ticker, covered: [] });
    }
    const analysis = readAnalysis(advice, ticker);
    if (!analysis) {
      const status = analystStatus(advice, ticker);
      const why = status === undefined ? `Quantcomm has no analyst view of ${ticker}.` : `Quantcomm's analyst for ${ticker} didn't finish its last run.`;
      throw new HttpError(404, "no_analyst_view", `${why} Analyst views cover: ${withViews.join(", ") || "none yet"}.`, { ticker, covered: withViews });
    }
    const pick = advice.picks.find((p) => p.ticker === ticker);
    return viewBody(m.companies.get(ticker)!, advice, analysis, pick);
  }

  // ---- x402 paywall ---------------------------------------------------------------------------------

  const facilitatorClient = new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });

  const routeFor = (price: string): RouteConfig => ({
    accepts: { scheme: "exact", network: BASE_SEPOLIA_NETWORK, payTo, price: `$${price}`, maxTimeoutSeconds: 300 },
    description: SERVICE_NAME,
    serviceName: PROVIDER,
    mimeType: "application/json",
    settlementFailedResponseBody: async () => ({
      contentType: "application/json",
      body: { error: "payment_not_settled", message: "The USDC payment did not settle, so nothing was charged. You can try again." },
    }),
  });

  const routes: RoutesConfig = {
    "GET /quantcomm/alerts": routeFor(PRICES.alerts),
    "GET /quantcomm/companies/*/flood": routeFor(PRICES.flood),
    "GET /quantcomm/companies/*/view": routeFor(PRICES.view),
  };

  function newResourceServer(): x402ResourceServer {
    const rs = new x402ResourceServer(facilitatorClient).register(BASE_SEPOLIA_NETWORK, new ExactEvmScheme());
    rs.onAfterSettle(async (ctx) => {
      const tx = ctx.result.transaction;
      const path = (ctx.transportContext as { request?: { path?: unknown } } | undefined)?.request?.path;
      log(`earned $${toDollars(String(ctx.requirements.amount))} from ${ctx.result.payer ?? "an agent"}${typeof path === "string" ? ` for ${path}` : ""} (tx ${explorerTxUrl(tx, config.chainMode, config.facilitatorUrl)})`);
    });
    return rs;
  }

  // syncFacilitatorOnStart: the first sync starts now, and the middleware retries lazily if it fails.
  // Its retry awaits the failed startup sync first, so the first paid request after a late facilitator
  // start would fail once; instead, watch the facilitator and rebuild the paywall when it answers.
  let paywall: RequestHandler = paymentMiddleware(routes, newResourceServer(), undefined, undefined, true);
  const retryMs = deps.facilitatorRetryMs ?? 2000;
  void (async () => {
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        await facilitatorClient.getSupported();
        if (attempt > 0) {
          paywall = paymentMiddleware(routes, newResourceServer(), undefined, undefined, true);
          log(`facilitator ${config.x402FacilitatorUrl} is up; paywall synced`);
        }
        return;
      } catch {
        if (attempt === 0) warn(`facilitator ${config.x402FacilitatorUrl} isn't answering yet; paid requests wait for it`);
      }
      await new Promise((r) => setTimeout(r, retryMs).unref());
    }
  })();

  // ---- app ----------------------------------------------------------------------------------------------

  const app = express() as QuantcommBridgeApp;
  app.locals.payTo = payTo;
  app.locals.upstream = upstream;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.path !== "/health") res.on("finish", () => log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
  });

  /** Build the answer before the paywall (every failure is answered here, unpaid), then charge, then send it. */
  const prepare =
    (build: (req: Request) => Promise<unknown>): RequestHandler =>
    async (req, res, next) => {
      res.locals.body = await build(req);
      next();
    };

  const deliver = (req: Request, res: Response): void => {
    // Defense in depth: a paid route is only ever answered behind a verified payment.
    if (!req.header("payment-signature") && !req.header("x-payment")) {
      throw new HttpError(500, "payment_not_verified", "This research is paid, and no verified payment reached it; nothing was charged.");
    }
    res.status(200).json(res.locals.body);
  };

  app.get("/health", async (_req, res) => {
    try {
      const m = await upstream.markets();
      res.json({ ok: true, upstream: "up", asOf: m.asOf });
    } catch (err) {
      if (isQuantcommError(err, "changed")) res.json({ ok: true, upstream: "up", note: `${CHANGED} (${err.where})` });
      else res.json({ ok: true, upstream: "down" });
    }
  });

  app.get("/quantcomm", async (_req, res) => {
    res.json(await buildIndex());
  });

  const paid: RequestHandler = (req, res, next) => paywall(req, res, next);
  app.get("/quantcomm/alerts", prepare(() => buildAlerts()), paid, deliver);
  app.get("/quantcomm/companies/:ticker/flood", prepare((req) => buildFlood(String(req.params.ticker))), paid, deliver);
  app.get("/quantcomm/companies/:ticker/view", prepare((req) => buildView(String(req.params.ticker))), paid, deliver);

  // ---- 404 / errors -------------------------------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `${req.method} ${req.path}` });
  });
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra ?? {}) });
      return;
    }
    if (err instanceof QuantcommError) {
      if (err.kind === "changed") {
        warn(`Quantcomm's API changed: ${err.where}`);
        res.status(502).json({ error: "quantcomm_changed", message: CHANGED, details: { where: err.where } });
      } else {
        warn(`Quantcomm unavailable: ${err.where ?? err.message}`);
        res.status(503).json({ error: "quantcomm_unavailable", message: err.message, ...(err.where ? { details: { reason: err.where } } : {}) });
      }
      return;
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) warn(`error: ${err.stack ?? err.message}`);
    res.status(status).json({ error: status < 500 ? "bad_request" : "internal_error", message: status < 500 ? "Bad request." : "Internal error." });
  });

  return app;
}
