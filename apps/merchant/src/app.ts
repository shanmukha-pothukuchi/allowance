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
  const newResourceServer = () => new x402ResourceServer(facilitatorClient).register(BASE_SEPOLIA_NETWORK, new ExactEvmScheme());
  const accepts = (price: string) => ({ scheme: "exact", price, network: BASE_SEPOLIA_NETWORK, payTo, maxTimeoutSeconds: 300 });
  const routes: RoutesConfig = {
    "GET /api/weather": { accepts: accepts("$0.05"), description: "Acme Weather", serviceName: SITE_NAME, mimeType: "application/json" },
    "GET /api/news": { accepts: accepts("$0.10"), description: "Acme News", serviceName: SITE_NAME, mimeType: "application/json" },
    "GET /api/stock": { accepts: accepts("$0.15"), description: "Acme Stock Quote", serviceName: SITE_NAME, mimeType: "application/json" },
    "POST /pizza/order": { accepts: accepts("$18.50"), description: "Acme Pizza order", serviceName: SITE_NAME, mimeType: "application/json" },
  };
  // syncFacilitatorOnStart=true: initialization is kicked off now and, if the facilitator is
  // not up yet, retried lazily on the first paid request instead of crashing the process
  // (verified in @x402/express: only capability/route-config errors are fatal). That retry awaits
  // the failed startup sync first, so the first paid request after a late facilitator start would
  // answer 500 once; instead, watch the facilitator and rebuild the paywall when it answers.
  let paywall: RequestHandler = paymentMiddleware(routes, newResourceServer(), undefined, undefined, true);
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
        if (attempt === 0) log(`facilitator ${config.x402FacilitatorUrl} isn't answering yet; paid requests wait for it`);
      }
      await new Promise((r) => setTimeout(r, 2000).unref());
    }
  })();
  app.use((req, res, next) => paywall(req, res, next));

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
    const status = err.status ?? 500;
    const code = status === 400 ? "invalid_request" : status === 413 ? "payload_too_large" : status < 500 ? "bad_request" : "internal_error";
    res.status(status).json({ error: code, message: status < 500 ? "Malformed request body." : "Internal error." });
  });

  return app;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Index page: the Allowance tokens (dark by default, light on prefers-color-scheme), grouped rows. */
function indexPage(config: AppConfig, payTo: string): string {
  const explorer = `${config.facilitatorUrl}/explorer`;
  const explorerHost = explorer.replace(/^https?:\/\//, "").replace(/\/explorer$/, "");
  const row = (label: string, path: string, href: string | null, right: string, note = "") =>
    `<li>${href ? `<a class="r" href="${esc(href)}">` : `<div class="r">`}<span class="l">${label ? `<span class="name">${esc(label)}</span>` : ""}${path ? `<code>${esc(path)}</code>` : ""}${note}</span><span class="v">${right}</span>${href ? "</a>" : "</div>"}</li>`;
  const ok = `<span class="st">200</span>`;
  const fails = `<span class="st"><span class="dot err" aria-hidden="true"></span>500 always</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${SITE_NAME}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--bg:#101114;--hover:rgba(255,255,255,.045);--text:#ececee;--text-2:#a4a6ad;--text-3:#7e8189;--line:#22242a;--fill-2:#222328;--accent:#6e79e0;--card:#15161a;--card-line:#24262c;--red:#eb6a6a;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--font:"Google Sans",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#fff;--hover:rgba(15,15,20,.045);--text:#1c1d21;--text-2:#55565f;--text-3:#74767f;--line:#ebebee;--fill-2:#ebebee;--accent:#5e6ad2;--card:#fff;--card-line:#e6e6ea;--red:#d64545}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
code{font-family:var(--mono);font-size:12.5px}
.wrap{max-width:880px;margin:0 auto;padding:32px 16px 40px}
h1{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.lede{margin:2px 0 0;color:var(--text-3);font-size:13px}.lede code{font-size:12px;color:var(--text-2);overflow-wrap:anywhere}
h2{display:flex;align-items:center;gap:8px;margin:28px 0 8px;font-size:13px;font-weight:500;color:var(--text-2)}
.tag{font-size:11.5px;font-weight:500;padding:0 7px;border-radius:6px;background:var(--fill-2);color:var(--text-3)}
ul{list-style:none;padding:0;margin:0;background:var(--card);border:1px solid var(--card-line);border-radius:10px;overflow:hidden}
li+li{border-top:1px solid var(--line)}
.r{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:38px;padding:8px 14px;color:inherit}
a.r:hover{background:var(--hover);text-decoration:none}
.l{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 10px;min-width:0}
.name{font-weight:500}.l code{color:var(--text-2);overflow-wrap:anywhere}
.v{color:var(--text-2);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.st{display:inline-flex;align-items:center;gap:6px;color:var(--text-3);font-size:12.5px}
.dot{width:7px;height:7px;border-radius:50%}.dot.err{background:var(--red)}
.v .muted{color:var(--text-3);font-size:12.5px;white-space:normal}
@media (max-width:560px){.wrap{padding-top:20px}.r{padding:8px 12px}.hint{display:none}}
</style></head><body><div class="wrap">
<h1>${SITE_NAME}</h1>
<p class="lede">Demo merchant for Allowance · x402 v2 · USDC on <code>eip155:84532</code> · pays to <code>${esc(payTo)}</code></p>
<h2>Paid APIs <span class="tag">x402</span></h2>
<ul>
${row("Weather", "GET /api/weather?city=", "/api/weather?city=Paris", "$0.05")}
${row("News", "GET /api/news", "/api/news", "$0.10")}
${row("Stock quote", "GET /api/stock?symbol=", "/api/stock?symbol=ACME", "$0.15")}
${row("Pizza order", "POST /pizza/order", null, "$18.50", ` <span class="tag" title="No pizza is made and no card is charged">Simulated</span>`)}
</ul>
<h2>Free test target</h2>
<ul>
${row("", "GET /test-target/users", "/test-target/users", ok)}
${row("", "GET /test-target/orders", "/test-target/orders", fails)}
${row("", "GET /test-target/products", "/test-target/products", ok)}
${row("", "GET /test-target/inventory", "/test-target/inventory", fails)}
${row("", "GET /test-target/health", "/test-target/health", ok)}
</ul>
<h2>Work for agents <span class="tag">agent-work</span></h2>
<ul>
${row("Bounty board", "GET /.well-known/agent-work", "/.well-known/agent-work", `<span class="muted hint">HTML for browsers, JSON for agents</span>`)}
${row("Ledger explorer", "", explorer, `<span class="muted">${esc(explorerHost)}</span>`)}
</ul>
</div></body></html>`;
}
