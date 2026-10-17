/**
 * Acme APIs: the demo merchant. Three x402-paid APIs, a (simulated) pizza order endpoint,
 * a free test-target used by the api-reliability-check bounty, and the agent-work bounty
 * board (mounted from @allowance/agent-work when that package is available).
 * See docs/ARCHITECTURE.md §7.
 */
import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { type AppConfig, BASE_SEPOLIA_NETWORK, newId } from "@allowance/shared";
import { loadCompanyAccount, type CompanyAccount } from "./wallet.js";
import { createBounties, type BountyConfig, type VerifyFn } from "./bounties.js";
import { createPayout, type PayoutFn } from "./payout.js";

export const SITE_NAME = "Acme APIs";
export const AGENT_WORK_LINK = '</.well-known/agent-work>; rel="agent-work"';

/** Minimal view of @allowance/agent-work (built in parallel; may be absent). */
export interface AgentWorkModule {
  agentWork: (opts: {
    site: { name: string; url: string };
    bounties: BountyConfig[];
    verify: VerifyFn;
    payout: PayoutFn;
    basePath?: string;
    onEvent?: (e: { type: string } & Record<string, unknown>) => void;
  }) => RequestHandler;
  agentWorkLinkHeader?: () => RequestHandler;
}

export interface MerchantDeps {
  /** Company wallet; defaults to loadCompanyAccount(config). */
  account?: CompanyAccount;
  /** `undefined` = try to import @allowance/agent-work; `null` = skip; or inject a module. */
  agentWork?: AgentWorkModule | null;
  payout?: PayoutFn;
  quiet?: boolean;
}

export interface MerchantApp extends Express {
  locals: Express["locals"] & {
    account: CompanyAccount;
    address: `0x${string}`;
    bounties: BountyConfig[];
    verify: VerifyFn;
    payout: PayoutFn;
    agentWorkMounted: boolean;
  };
}

export async function createMerchantApp(config: AppConfig, deps: MerchantDeps = {}): Promise<MerchantApp> {
  const log = deps.quiet ? () => {} : (msg: string) => console.log(`[merchant] ${msg}`);
  const account = deps.account ?? loadCompanyAccount(config);
  const payTo = account.address;
  const { bounties, verify } = createBounties(config.merchantUrl);
  const payout = deps.payout ?? createPayout(config, account);

  const app = express() as MerchantApp;
  app.locals.account = account;
  app.locals.address = payTo;
  app.locals.bounties = bounties;
  app.locals.verify = verify;
  app.locals.payout = payout;
  app.locals.agentWorkMounted = false;
  app.disable("x-powered-by");

  // ---- global middleware: Link header, JSON, one-line request log ---------------
  app.use((req, res, next) => {
    res.setHeader("Link", AGENT_WORK_LINK);
    res.on("finish", () => log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  // ---- index ------------------------------------------------------------------------
  app.get("/", (_req, res) => {
    res.setHeader("Vary", "Accept");
    res.type("html").send(indexPage(config, payTo));
  });

  // ---- x402 paid routes -------------------------------------------------------------
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(BASE_SEPOLIA_NETWORK, new ExactEvmScheme());
  const accepts = (price: string) => ({ scheme: "exact", price, network: BASE_SEPOLIA_NETWORK, payTo, maxTimeoutSeconds: 300 });
  const routes: RoutesConfig = {
    "GET /api/weather": { accepts: accepts("$0.05"), description: "Acme Weather", serviceName: SITE_NAME, mimeType: "application/json" },
    "GET /api/news": { accepts: accepts("$0.10"), description: "Acme News", serviceName: SITE_NAME, mimeType: "application/json" },
    "GET /api/stock": { accepts: accepts("$0.15"), description: "Acme Stock Quote", serviceName: SITE_NAME, mimeType: "application/json" },
    "POST /pizza/order": { accepts: accepts("$18.50"), description: "Acme Pizza order", serviceName: SITE_NAME, mimeType: "application/json" },
  };
  // syncFacilitatorOnStart=true: initialization is kicked off now and, if the facilitator is
  // not up yet, retried lazily on the first paid request instead of crashing the process
  // (verified in @x402/express: only capability/route-config errors are fatal).
  app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, true));

  app.get("/api/weather", (req, res) => {
    const city = typeof req.query.city === "string" && req.query.city.trim() ? req.query.city.trim() : "San Francisco";
    const seed = hashStr(city.toLowerCase());
    const tempC = 8 + (seed % 20);
    const summaries = ["clear skies", "light rain", "overcast", "partly cloudy", "fog rolling in", "sunny and mild"];
    res.json({ city, tempC, summary: summaries[seed % summaries.length] });
  });

  app.get("/api/news", (_req, res) => {
    res.json({
      headlines: [
        "Agents now pay for APIs with USDC micropayments",
        "Base Sepolia transaction volume hits new testnet high",
        "Websites start posting paid tasks for AI agents",
        "Policy wallets stop prompt-injection drains, study finds",
        "Acme APIs ships v2.4.0 with hourly forecasts",
      ],
    });
  });

  app.get("/api/stock", (req, res) => {
    const symbol = (typeof req.query.symbol === "string" && req.query.symbol.trim() ? req.query.symbol.trim() : "ACME").toUpperCase();
    const seed = hashStr(symbol);
    const price = (50 + (seed % 450) + (seed % 100) / 100).toFixed(2);
    const change = `${seed % 2 === 0 ? "+" : "-"}${((seed % 500) / 100).toFixed(2)}%`;
    res.json({ symbol, price, change });
  });

  /**
   * SIMULATED FULFILLMENT. There is no real card issuer, no off-ramp, no pizza shop.
   * The x402 payment is real within the ledger; what happens after is pretend: we return a
   * fake order id and say "virtual card issued". Do not ship this to production as-is.
   */
  app.post("/pizza/order", (req, res) => {
    const body = (req.body ?? {}) as { size?: unknown; toppings?: unknown; address?: unknown };
    const size = typeof body.size === "string" && body.size.trim() ? body.size.trim() : "large";
    const toppings = Array.isArray(body.toppings) ? body.toppings.filter((t) => typeof t === "string").slice(0, 8) : [];
    const address = typeof body.address === "string" && body.address.trim() ? body.address.trim() : "123 Demo Street";
    const orderId = newId("ord");
    log(`pizza order ${orderId}: ${size}, toppings=[${toppings.join(", ")}] to "${address}" (simulated)`);
    res.json({
      orderId,
      status: "placed",
      eta: "25 min",
      card: "virtual card issued",
      simulated: true,
      note: "Fulfillment is simulated for the demo",
      order: { size, toppings, address, total: "18.50" },
    });
  });

  // ---- free test-target (used by the api-reliability-check bounty) -------------------
  app.get("/test-target/users", (_req, res) => res.json({ users: [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }] }));
  app.get("/test-target/products", (_req, res) => res.json({ products: [{ sku: "PZ-1", name: "Margherita", price: "18.50" }] }));
  app.get("/test-target/health", (_req, res) => res.json({ ok: true }));
  app.get("/test-target/orders", (_req, res) => res.status(500).json({ error: "upstream_timeout", message: "orders service timed out" }));
  app.get("/test-target/inventory", (_req, res) => res.status(500).json({ error: "upstream_timeout", message: "inventory service timed out" }));

  // ---- agent-work bounty board (optional until @allowance/agent-work exists) ---------
  let aw = deps.agentWork;
  if (aw === undefined) {
    const spec = "@allowance/agent-work"; // variable specifier: tsc must not resolve it at compile time
    aw = (await import(spec).catch(() => null)) as AgentWorkModule | null;
  }
  if (aw && typeof aw.agentWork === "function") {
    if (typeof aw.agentWorkLinkHeader === "function") app.use(aw.agentWorkLinkHeader());
    app.use(
      aw.agentWork({
        site: { name: SITE_NAME, url: config.merchantUrl },
        bounties,
        verify,
        payout,
        onEvent: (e) => log(`agent-work ${e.type} ${JSON.stringify({ ...e, type: undefined })}`),
      }),
    );
    app.locals.agentWorkMounted = true;
    log("agent-work bounty board mounted at /.well-known/agent-work");
  } else {
    log("agent-work middleware not available yet");
  }

  // ---- 404 / errors as JSON ---------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `${req.method} ${req.path}` });
  });
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    log(`error: ${err.message}`);
    res.status(err.status ?? 500).json({ error: "internal_error", message: err.message });
  });

  return app;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function indexPage(config: AppConfig, payTo: string): string {
  const explorer = `${config.facilitatorUrl}/explorer`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${SITE_NAME}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;padding:32px;background:#f6f7f9;color:#111827;font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
h1{font-size:26px;margin:0 0 4px}.sub{color:#6b7280;margin:0 0 24px}h2{font-size:18px;margin:28px 0 8px;color:#374151}
ul{list-style:none;padding:0;margin:0;background:#fff;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
li{padding:12px 16px;border-bottom:1px solid #eef0f3;display:flex;justify-content:space-between;gap:16px}li:last-child{border:0}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.price{color:#6b7280;white-space:nowrap}.tag{font-size:12px;background:#dbeafe;color:#1e40af;border-radius:999px;padding:2px 8px}
</style></head><body>
<h1>${SITE_NAME}</h1>
<p class="sub">Demo merchant for Allowance. Paid endpoints use <strong>x402 v2</strong> (USDC on <code>eip155:84532</code>). Payments go to <code>${payTo}</code>.</p>
<h2>Paid APIs <span class="tag">x402</span></h2>
<ul>
<li><a href="/api/weather?city=Paris"><code>GET /api/weather?city=</code></a><span class="price">$0.05</span></li>
<li><a href="/api/news"><code>GET /api/news</code></a><span class="price">$0.10</span></li>
<li><a href="/api/stock?symbol=ACME"><code>GET /api/stock?symbol=</code></a><span class="price">$0.15</span></li>
<li><code>POST /pizza/order</code> <span class="price">$18.50 · fulfillment simulated</span></li>
</ul>
<h2>Free test target</h2>
<ul>
<li><a href="/test-target/users"><code>GET /test-target/users</code></a><span class="price">200</span></li>
<li><a href="/test-target/orders"><code>GET /test-target/orders</code></a><span class="price">500 (always)</span></li>
<li><a href="/test-target/products"><code>GET /test-target/products</code></a><span class="price">200</span></li>
<li><a href="/test-target/inventory"><code>GET /test-target/inventory</code></a><span class="price">500 (always)</span></li>
<li><a href="/test-target/health"><code>GET /test-target/health</code></a><span class="price">200</span></li>
</ul>
<h2>Work for agents <span class="tag">agent-work</span></h2>
<ul>
<li><a href="/.well-known/agent-work"><code>GET /.well-known/agent-work</code></a><span class="price">bounty board (HTML for browsers, JSON for agents)</span></li>
<li><a href="${explorer}">Ledger explorer</a><span class="price">${explorer}</span></li>
</ul>
</body></html>`;
}
