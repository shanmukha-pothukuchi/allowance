import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { loadConfig, toBaseUnits } from "@allowance/shared";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createComputerUseApp, type ComputerUseApp } from "./app.js";
import { loadComputerUseConfig, type ComputerUseConfig } from "./config.js";
import { DesktopError, looksLikeCardNumber, parseAction } from "./desktop.js";
import { ACTION_PRICES, MAX_PRICE, PRICING, READ_PRICES, timePrice } from "./prices.js";
import { FakeDesktopDriver, ManualClock, TINY_PNG } from "./test-desktop.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}
const close = (s: Server) =>
  new Promise<void>((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MINUTE = 60_000;

type Json = Record<string, any>;

describe("action rules", () => {
  it("validates bodies, refuses card numbers and known password fields", () => {
    expect(parseAction("navigate", { url: "https://example.com" })).toEqual({ kind: "navigate", url: "https://example.com" });
    expect(() => parseAction("navigate", { url: "javascript:alert(1)" })).toThrow(/Only http/);
    expect(() => parseAction("navigate", { url: "file:///etc/passwd" })).toThrow(/Only http/);
    expect(parseAction("navigate", { url: "example.com:8080/x" }).url).toBe("example.com:8080/x");
    expect(() => parseAction("click", {})).toThrow(/needs element/);
    expect(() => parseAction("click", { x: 5000, y: 1 })).toThrow(/screen/);
    expect(parseAction("click", { element: 3, extra: "dropped" })).toEqual({ kind: "click", element: 3 });
    expect(() => parseAction("key", { keys: "ctrl+a; rm -rf" })).toThrow(/key needs keys/);
    expect(() => parseAction("teleport", {})).toThrow(/Unknown action/);
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("order 1234567890123")).toBe(false);
    expect(() => parseAction("type", { text: "card 4111-1111-1111-1111" })).toThrow(/card number/);
    expect(() => parseAction("type", { element: 4, text: "hunter2" }, new Set([4]))).toThrow(/password field/);
    expect(parseAction("type", { element: 3, text: "hello", submit: true })).toEqual({ kind: "type", element: 3, text: "hello", submit: true });
  });

  it("prices: no flat rate, the largest single payment is 5 minutes", () => {
    expect(timePrice(1)).toBe("0.02");
    expect(timePrice(5)).toBe("0.10");
    expect(MAX_PRICE).toBe("0.10");
    expect(PRICING).toBe("$0.02 per minute · $0.005 per action · reads from $0.002");
    for (const p of [...Object.values(ACTION_PRICES), ...Object.values(READ_PRICES)]) expect(Number(p)).toBeLessThan(Number(timePrice(1)));
  });

  it("config: COMPUTER_USE_* variables with defaults", () => {
    const base = loadConfig();
    const d = loadComputerUseConfig({}, base);
    expect(d).toMatchObject({ computerUsePort: 4090, computerUseUrl: "http://localhost:4090", computerUseSeats: 1, docker: { image: "allowance-cu-desktop:latest", access: "ip" } });
    const c = loadComputerUseConfig({ COMPUTER_USE_PORT: "4491", COMPUTER_USE_SEATS: "2", COMPUTER_USE_URL: "http://127.0.0.1:4491/", COMPUTER_USE_DNS: "9.9.9.9, bad;dns" }, base);
    expect(c).toMatchObject({ computerUsePort: 4491, computerUseSeats: 2, computerUseUrl: "http://127.0.0.1:4491", docker: { dns: ["9.9.9.9"] } });
  });
});

describe("computer use service", () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const earnings = privateKeyToAccount(generatePrivateKey());
  let facServer: Server;
  let proxyServer: Server;
  let facUrl: string;
  let proxyUrl: string;
  let failSettle = false;
  const servers: Server[] = [];

  const balance = async (addr: string) => BigInt(((await (await fetch(`${facUrl}/balance/${addr}`)).json()) as { balanceBaseUnits: string }).balanceBaseUnits);

  interface Env {
    url: string;
    app: ComputerUseApp;
    driver: FakeDesktopDriver;
    clock: ManualClock;
    config: ComputerUseConfig;
  }

  async function start(over: Partial<ComputerUseConfig> = {}, driver = new FakeDesktopDriver()): Promise<Env> {
    const server = createServer();
    const url = await listen(server);
    servers.push(server);
    const clock = new ManualClock();
    const config: ComputerUseConfig = {
      ...loadComputerUseConfig({}, loadConfig()),
      chainMode: "mock",
      dataDir: mkdtempSync(join(tmpdir(), "allowance-cu-")),
      facilitatorUrl: facUrl,
      x402FacilitatorUrl: proxyUrl,
      computerUseUrl: url,
      computerUseStartGraceSeconds: 60,
      ...over,
    };
    const app = createComputerUseApp(config, { driver, account: earnings, clock, quiet: true });
    server.on("request", app);
    return { url, app, driver, clock, config };
  }

  const call = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: Json = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, body: json, headers: r.headers, text };
  };
  const pay = async (method: string, url: string, body?: unknown) => {
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
    const r = await wrapFetchWithPayment(fetch, client)(url, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = r.headers.get("content-type") ?? "";
    const raw = Buffer.from(await r.arrayBuffer());
    let json: Json = {};
    if (ct.includes("json")) json = JSON.parse(raw.toString());
    return { status: r.status, body: json, raw, headers: r.headers };
  };
  const paid = async (method: string, url: string, body?: unknown) => {
    const r = await pay(method, url, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(decodePaymentResponseHeader(r.headers.get("payment-response")!)).toMatchObject({ success: true });
    return r;
  };
  /** Answered before the paywall: no 402, and a paying client is not charged. */
  const refused = async (method: string, url: string, status: number, error: string, body?: unknown) => {
    const before = await balance(buyer.address);
    const unpaid = await call(method, url, body);
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(status);
    expect(unpaid.body.error).toBe(error);
    expect(unpaid.headers.get("payment-required")).toBeNull();
    const paying = await pay(method, url, body);
    expect(paying.status).toBe(status);
    expect(await balance(buyer.address)).toBe(before);
    return unpaid.body;
  };
  const challenge = async (method: string, url: string, body?: unknown) => {
    const r = await call(method, url, body);
    expect(r.status, `${method} ${url}: ${JSON.stringify(r.body)}`).toBe(402);
    return decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
  };

  /** A session with its URLs (the token is in each). */
  async function session(env: Env, label?: string) {
    const r = await call("POST", `${env.url}/computer/sessions`, label ? { label } : {});
    expect([201, 202], JSON.stringify(r.body)).toContain(r.status);
    const base = `${env.url}/computer/sessions/${r.body.id}`;
    const t = `?token=${r.body.token}`;
    return {
      res: r,
      id: r.body.id as string,
      token: r.body.token as string,
      viewToken: new URL(r.body.viewUrl).searchParams.get("token")!,
      status: `${base}${t}`,
      time: (m = 1) => `${base}/time${t}&minutes=${m}`,
      action: (k: string) => `${base}/actions/${k}${t}`,
      snapshot: `${base}/snapshot${t}`,
      screenshot: (f = "jpeg") => `${base}/screenshot${t}&format=${f}`,
      end: `${base}/end${t}`,
      view: (tok: string) => `${base}/view?token=${tok}`,
      stream: (tok: string) => `${base}/stream?token=${tok}`,
      base,
    };
  }

  beforeAll(async () => {
    const facApp = createFacilitatorApp({ ...loadConfig(), ownerApiKey: undefined, dataDir: mkdtempSync(join(tmpdir(), "allowance-fac-")) }, { quiet: true });
    facServer = createServer(facApp);
    facUrl = await listen(facServer);
    const proxy = express();
    proxy.use(express.json());
    proxy.get("/supported", async (_req, res) => res.json(await (await fetch(`${facUrl}/supported`)).json()));
    proxy.post("/verify", async (req, res) => {
      const r = await fetch(`${facUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
      res.status(r.status).json(await r.json());
    });
    proxy.post("/settle", async (req, res) => {
      if (failSettle) return void res.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
      const r = await fetch(`${facUrl}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
      res.status(r.status).json(await r.json());
    });
    proxyServer = createServer(proxy);
    proxyUrl = await listen(proxyServer);
    await fetch(`${facUrl}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: buyer.address, amount: "5.00" }) });
  });

  afterAll(async () => {
    for (const s of servers) await close(s);
    await close(proxyServer);
    await close(facServer);
  });

  it("GET /computer is a free index of prices, seats and the queue", async () => {
    const env = await start({ computerUseSeats: 2 });
    const r = await call("GET", `${env.url}/computer`);
    expect(r.status).toBe(200);
    expect(r.headers.get("payment-required")).toBeNull();
    expect(r.body).toMatchObject({
      name: "Computer",
      provider: "Allowance",
      available: true,
      seats: 2,
      active: 0,
      queued: 0,
      pricing: PRICING,
      prices: { perMinute: "0.02", maxMinutesPerPayment: 5, maxPayment: "0.10", actions: { click: "0.005", key: "0.003", navigate: "0.005" }, reads: { snapshot: "0.002", screenshot: "0.003" } },
      limits: { screen: "1280x800", startGraceSeconds: 60, maxSessionMinutes: 30, maxLeaseAheadMinutes: 10 },
    });
    expect(r.body.rules.join(" ")).toMatch(/Never type card numbers or passwords/);
    expect((await call("GET", `${env.url}/health`)).body).toEqual({ ok: true, seats: 2, active: 0, queued: 0, desktop: "ready" });
  });

  it("Docker unavailable → 503 computer_unavailable, nothing queued", async () => {
    const env = await start();
    env.driver.available = false;
    const r = await call("POST", `${env.url}/computer/sessions`, {});
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "computer_unavailable" });
    expect(r.body.message).toMatch(/Nothing was charged/);
    expect(env.app.locals.manager.sessions.size).toBe(0);
    expect((await call("GET", `${env.url}/computer`)).body).toMatchObject({ available: false, unavailable: "Docker isn't reachable on this machine." });
  });

  it("a free seat starts a session (active, desktop started); the next one queues with its position and a wait", async () => {
    const env = await start();
    const a = await session(env, "researcher");
    expect(a.res.status).toBe(201);
    expect(a.res.body).toMatchObject({ status: "active", seat: 1, label: "researcher", lease: { secondsLeft: 0, payWithinSeconds: 60 } });
    expect(a.token).toMatch(/^cut_[0-9a-f]{48}$/);
    expect(a.res.body.viewUrl).toMatch(/\/view\?token=cuv_[0-9a-f]{32}$/);
    expect(a.res.body.urls.time).toBe(`POST ${a.base}/time?token=${a.token}&minutes=1`);
    expect(a.res.body.next).toMatch(/Buy the first minute within 60 s/);
    await sleep(5);
    expect(env.driver.started).toEqual([a.id]);
    expect((await call("GET", a.status)).body.desktop).toBe("ready");

    const b = await session(env);
    expect(b.res.status).toBe(202);
    expect(b.res.body).toMatchObject({ status: "queued", position: 1, queueLength: 1, estimatedWaitSeconds: 60 });
    expect(b.res.body.next).toMatch(/Poll .* \(free\)/);
    expect(env.driver.started).toEqual([a.id]);
    const c = await session(env);
    expect(c.res.body).toMatchObject({ status: "queued", position: 2, estimatedWaitSeconds: 60 + 180 });

    // Polling is free, with either token; the view token sees no control URLs.
    const viaView = await call("GET", `${b.base}?token=${b.viewToken}`);
    expect(viaView.status).toBe(200);
    expect(viaView.body).toMatchObject({ id: b.id, status: "queued", position: 1 });
    expect(viaView.body).not.toHaveProperty("urls");
    expect(viaView.body).not.toHaveProperty("next");
    expect(JSON.stringify(viaView.body)).not.toContain(b.token);
  });

  it("sessions belong to their creator: unknown, missing, wrong and view-only tokens are refused before the paywall", async () => {
    const env = await start();
    const a = await session(env);
    const b = await session(env);
    await refused("POST", `${a.base}/time?minutes=1`, 401, "token_required");
    await refused("POST", `${a.base}/time?token=${b.token}&minutes=1`, 403, "wrong_token");
    await refused("POST", `${a.base}/time?token=${a.viewToken}&minutes=1`, 403, "view_only");
    await refused("POST", `${a.base}/actions/click?token=${a.viewToken}`, 403, "view_only", { element: 1 });
    await refused("GET", `${a.base}/snapshot?token=nope`, 403, "wrong_token");
    await refused("POST", `${env.url}/computer/sessions/cus_000/time?token=${a.token}`, 404, "session_not_found");
    expect((await call("POST", `${a.base}/end?token=${a.viewToken}`)).status).toBe(403);
    expect((await call("GET", `${a.base}`)).status).toBe(401);
  });

  it("402s: priced from the URL alone, described per minute and per action kind, paid to the earnings wallet", async () => {
    const env = await start();
    const a = await session(env);
    const cases: [string, string, unknown, string, string][] = [
      ["POST", a.time(1), undefined, "20000", "Computer use · 1 minute"],
      ["POST", a.time(3), undefined, "60000", "Computer use · 3 minutes"],
      ["POST", a.time(5), undefined, "100000", "Computer use · 5 minutes"],
    ];
    for (const [method, url, body, amount, description] of cases) {
      const pr = await challenge(method, url, body);
      expect(pr.accepts).toHaveLength(1);
      expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount, maxTimeoutSeconds: 300 });
      expect(getAddress(pr.accepts[0].payTo)).toBe(earnings.address);
      expect(pr.resource).toMatchObject({ description, serviceName: "Allowance" });
    }
    await refused("POST", a.time(6), 400, "invalid_minutes");
    await refused("POST", a.time(0), 400, "invalid_minutes");
    await paid("POST", a.time(1));
    for (const [kind, amount] of [["click", "5000"], ["navigate", "5000"], ["type", "5000"], ["key", "3000"], ["scroll", "3000"], ["back", "3000"]] as const) {
      const pr = await challenge("POST", a.action(kind));
      expect(pr.accepts[0].amount).toBe(amount);
      expect(pr.resource.description).toBe(`Computer use · ${kind}`);
    }
    expect((await challenge("GET", a.snapshot)).accepts[0].amount).toBe("2000");
    expect((await challenge("GET", a.snapshot)).resource.description).toBe("Computer use · text snapshot");
    expect((await challenge("GET", a.screenshot())).resource.description).toBe("Computer use · screenshot");
    expect((await challenge("GET", a.screenshot())).accepts[0].amount).toBe("3000");
  });

  it("the wallet's bodyless re-fetch gets the same 402 as the agent's request with a body", async () => {
    const env = await start();
    const a = await session(env);
    await paid("POST", a.time(1));
    const withBody = await challenge("POST", a.action("click"), { element: 1 });
    const bodyless = await challenge("POST", a.action("click"));
    expect(bodyless.accepts).toEqual(withBody.accepts);
    expect(bodyless.resource.description).toBe(withBody.resource.description);
    // A bad body is refused before the paywall, so it can't be paid at all.
    await refused("POST", a.action("click"), 400, "invalid_action", { element: "twelve" });
    await refused("POST", a.action("teleport"), 404, "unknown_action", { to: "mars" });
  });

  it("buying the first minute starts the lease: USDC to the earnings wallet, lease and spend in the status", async () => {
    const env = await start();
    const a = await session(env);
    await refused("POST", a.action("navigate"), 409, "lease_required", { url: "https://example.com" });
    const msg = (await call("GET", a.snapshot)).body.message;
    expect(msg).toContain(`POST ${a.base}/time?token=${a.token}&minutes=1`);

    const before = await balance(buyer.address);
    const earnedBefore = await balance(earnings.address);
    const r = await paid("POST", a.time(1));
    expect(r.body).toMatchObject({ id: a.id, status: "active", bought: "1 minute", lease: { secondsLeft: 60 } });
    expect(before - (await balance(buyer.address))).toBe(toBaseUnits("0.02"));
    expect((await balance(earnings.address)) - earnedBefore).toBe(toBaseUnits("0.02"));
    const s = (await call("GET", a.status)).body;
    expect(s).toMatchObject({ status: "active", lease: { secondsLeft: 60 }, spent: { total: "0.02", time: "0.02", minutesBought: 1, actionCount: 0 } });
    expect(s.next).toMatch(/^Lease 60 s left/);

    // Renewing adds to the end of the lease, not to now.
    env.clock.advance(20_000);
    const renew = await paid("POST", a.time(2));
    expect(renew.body.lease.secondsLeft).toBe(40 + 120);
    expect((await call("GET", a.status)).body).toMatchObject({ lease: { secondsLeft: 160 }, spent: { time: "0.06", minutesBought: 3 } });
  });

  it("actions and reads are paid one by one; receipts name the kind; spend adds up", async () => {
    const env = await start();
    const a = await session(env);
    await paid("POST", a.time(1));
    const before = await balance(buyer.address);

    const nav = await paid("POST", a.action("navigate"), { url: "https://example.com" });
    expect(nav.body).toMatchObject({ ok: true, action: "navigate", url: "https://example.com", title: "Example Domain", lease: { secondsLeft: 60 } });
    const snap = await paid("GET", a.snapshot);
    expect(snap.body).toMatchObject({ url: "https://example.com", title: "Example Domain" });
    expect(snap.body.elements[0]).toMatchObject({ n: 1, role: "link", label: "More information…", x: 200, y: 300 });
    expect(snap.body.text).toContain("[1] More information…");
    const click = await paid("POST", a.action("click"), { element: 1 });
    expect(click.body).toMatchObject({ action: "click", url: "https://www.iana.org/domains/example" });
    const shot = await paid("GET", a.screenshot("png"));
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(shot.raw.equals(TINY_PNG)).toBe(true);
    expect(shot.headers.get("x-computer-lease-seconds")).toBe("60");

    expect(before - (await balance(buyer.address))).toBe(toBaseUnits("0.005") * 2n + toBaseUnits("0.002") + toBaseUnits("0.003"));
    const s = (await call("GET", a.status)).body;
    expect(s.spent).toEqual({ total: "0.035", time: "0.02", actions: "0.01", reads: "0.005", minutesBought: 1, actionCount: 2, readCount: 2 });
    expect(s.page).toEqual({ url: "https://www.iana.org/domains/example", title: "IANA" });
    expect(env.driver.desktops.get(a.id)!.actions.map((x) => x.kind)).toEqual(["navigate", "click"]);
  });

  it("never charged for a failure inside the desktop after payment (status ≥ 400 is not settled)", async () => {
    const env = await start();
    const a = await session(env);
    await paid("POST", a.time(1));
    const desktop = env.driver.desktops.get(a.id)!;
    const before = await balance(buyer.address);
    const earnedBefore = await balance(earnings.address);

    desktop.failNext = new DesktopError(502, "input_failed", "xdotool click failed: no display");
    const failed = await pay("POST", a.action("click"), { element: 2 });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ error: "input_failed", message: "xdotool click failed: no display" });
    expect(failed.headers.get("payment-response")).toBeNull();

    const missing = await pay("POST", a.action("click"), { element: 99 });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("element_not_found");

    // A bodyless click passes the paywall check (it looks like the wallet's re-fetch), then fails validation: not charged.
    const empty = await pay("POST", a.action("click"));
    expect(empty.status).toBe(400);

    expect(await balance(buyer.address)).toBe(before);
    expect(await balance(earnings.address)).toBe(earnedBefore);
    const s = (await call("GET", a.status)).body;
    expect(s.spent).toMatchObject({ actions: "0.00", actionCount: 0 });
    expect(s.lastAction).toMatchObject({ kind: "click", ok: false });

    // The next one works and is charged.
    await paid("POST", a.action("click"), { element: 2 });
    expect(before - (await balance(buyer.address))).toBe(toBaseUnits("0.005"));
  });

  it("settlement failure → 402 payment_not_settled, no time added, nothing charged", async () => {
    const env = await start();
    const a = await session(env);
    const before = await balance(buyer.address);
    failSettle = true;
    try {
      const r = await pay("POST", a.time(1));
      expect(r.status).toBe(402);
      expect(r.body.error).toBe("payment_not_settled");
      expect(r.body.message).toMatch(/no time was added/);
    } finally {
      failSettle = false;
    }
    expect(await balance(buyer.address)).toBe(before);
    expect((await call("GET", a.status)).body).toMatchObject({ lease: { secondsLeft: 0 }, spent: { total: "0.00" } });
  });

  it("typing a card number or into a password field is refused for free", async () => {
    const env = await start();
    const a = await session(env);
    await paid("POST", a.time(1));
    await refused("POST", a.action("type"), 422, "card_number_refused", { element: 3, text: "4242 4242 4242 4242" });
    await paid("GET", a.snapshot); // element 4 is a password input
    await refused("POST", a.action("type"), 422, "password_field_refused", { element: 4, text: "hunter2" });
    await paid("POST", a.action("type"), { element: 3, text: "weather in Paris", submit: true });
  });

  it("queued sessions can't buy or act; ending the active one starts the next automatically", async () => {
    const env = await start();
    const a = await session(env);
    const b = await session(env);
    const c = await session(env);
    await refused("POST", b.time(1), 409, "session_queued");
    await refused("POST", b.action("navigate"), 409, "session_queued", { url: "https://example.com" });
    await paid("POST", a.time(1));

    const ended = await call("POST", a.end);
    expect(ended.body).toMatchObject({ status: "ended", endReason: "ended", spent: { total: "0.02" } });
    await sleep(5);
    expect(env.driver.stopped).toContain(`allowance-cu-${a.id}`);
    expect(env.driver.started).toEqual([a.id, b.id]);
    expect((await call("GET", b.status)).body).toMatchObject({ status: "active", seat: 1, desktop: "ready", lease: { payWithinSeconds: 60 } });
    expect((await call("GET", c.status)).body).toMatchObject({ status: "queued", position: 1 });
    await refused("POST", a.action("click"), 410, "session_ended", { element: 1 });
    await refused("POST", a.time(1), 410, "session_ended");

    // Cancelling a queued session is free and leaves the queue in order.
    const d = await session(env);
    expect((await call("DELETE", `${c.base}?token=${c.token}`)).body).toMatchObject({ status: "ended", endReason: "cancelled" });
    expect((await call("GET", d.status)).body).toMatchObject({ status: "queued", position: 1 });
  });

  it("the lease lapses without renewal: the session ends, its desktop is removed, the next in line starts", async () => {
    const env = await start();
    const a = await session(env);
    const b = await session(env);
    await paid("POST", a.time(1));
    env.clock.advance(59_000);
    expect((await call("GET", a.status)).body).toMatchObject({ status: "active", lease: { secondsLeft: 1 } });
    env.clock.advance(1_000);
    const s = (await call("GET", a.status)).body;
    expect(s).toMatchObject({ status: "ended", endReason: "lease_lapsed", spent: { total: "0.02" } });
    expect(s.message).toMatch(/time ran out/);
    await sleep(5);
    expect(env.driver.stopped).toEqual([`allowance-cu-${a.id}`]);
    expect((await call("GET", b.status)).body).toMatchObject({ status: "active", seat: 1 });
    await refused("GET", a.snapshot, 410, "session_ended");
  });

  it("a seat nobody pays for goes to the next in line after the start grace, free", async () => {
    const env = await start();
    const a = await session(env);
    const b = await session(env);
    env.clock.advance(60_000);
    expect((await call("GET", a.status)).body).toMatchObject({ status: "ended", endReason: "not_started", spent: { total: "0.00" } });
    expect((await call("GET", b.status)).body).toMatchObject({ status: "active" });
  });

  it("the lease holds at most 10 minutes ahead and a session at most 30 minutes", async () => {
    const env = await start();
    const a = await session(env);
    await paid("POST", a.time(5));
    await paid("POST", a.time(5));
    const full = await refused("POST", a.time(1), 409, "lease_full");
    expect(full.message).toMatch(/at most 10 minutes ahead/);
    for (let i = 0; i < 4; i++) {
      env.clock.advance(5 * MINUTE);
      await paid("POST", a.time(5));
    }
    // 30 minutes bought in all; one more would run the session past 30 minutes.
    env.clock.advance(5 * MINUTE);
    await refused("POST", a.time(1), 409, "session_limit");
  });

  it("a paid request in flight holds the lease until it finishes", async () => {
    const env = await start();
    const a = await session(env);
    await paid("POST", a.time(1));
    const m = env.app.locals.manager;
    const s = m.sessions.get(a.id)!;
    s.inFlight = 1;
    env.clock.advance(MINUTE + 2_000);
    expect(s.status).toBe("active");
    await refused("POST", a.action("click"), 410, "lease_lapsed", { element: 1 });
    s.inFlight = 0;
    env.clock.advance(500);
    expect(s.status).toBe("ended");
    expect(s.endReason).toBe("lease_lapsed");
  });

  it("a desktop that can't start ends its session (free) and the next one gets the seat", async () => {
    const driver = new FakeDesktopDriver();
    driver.failStart = true;
    driver.startDelayMs = 50;
    const env = await start({}, driver);
    const a = await session(env);
    const before = await balance(buyer.address);
    const r = await pay("POST", a.time(1));
    expect([410, 503]).toContain(r.status);
    expect(await balance(buyer.address)).toBe(before);
    await sleep(80);
    expect((await call("GET", a.status)).body).toMatchObject({ status: "ended", endReason: "desktop_failed" });
    driver.failStart = false;
    const b = await session(env);
    expect(b.res.body.status).toBe("active");
  });

  it("the viewer page and the live stream are free, with the session or view token", async () => {
    const env = await start();
    const a = await session(env);
    const b = await session(env);
    await sleep(5);
    const page = await fetch(a.view(a.viewToken));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(page.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self' http:\/\/localhost:4050/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("<title>Computer</title>");
    expect(html).toContain(a.id);
    expect(html).not.toContain(a.token);
    const bad = await fetch(a.view("nope"));
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain("Can't show this session");

    const ac = new AbortController();
    const stream = await fetch(a.stream(a.viewToken), { signal: ac.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=frame");
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString("latin1")).toMatch(/^--frame\r\nContent-Type: image\/jpeg/);
    ac.abort();
    await reader.cancel().catch(() => undefined);

    const queued = await call("GET", b.stream(b.viewToken));
    expect(queued).toMatchObject({ status: 409, body: { error: "not_live" } });

    // Ending the session ends its streams.
    const ac2 = new AbortController();
    const s2 = await fetch(a.stream(a.token), { signal: ac2.signal });
    const r2 = s2.body!.getReader();
    await r2.read();
    await call("POST", a.end);
    let done = false;
    for (let i = 0; i < 50 && !done; i++) done = (await r2.read()).done;
    expect(done).toBe(true);
  });

  it("shutdown ends every session and removes every desktop", async () => {
    const env = await start({ computerUseSeats: 2 });
    const a = await session(env);
    const b = await session(env);
    const c = await session(env);
    await sleep(5);
    await env.app.locals.shutdown();
    for (const x of [a, b, c]) expect((await call("GET", x.status)).body).toMatchObject({ status: "ended", endReason: "service_stopped" });
    expect(env.driver.stopped.sort()).toEqual([`allowance-cu-${a.id}`, `allowance-cu-${b.id}`].sort());
    expect(env.driver.cleanups).toBe(1);
    expect((await call("POST", `${env.url}/computer/sessions`, {})).status).toBe(503);
  });

  it("generates DATA_DIR/computer-use-key.json once (0600) and pays it as payTo after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-cu-key-"));
    const config = { ...loadComputerUseConfig({}, loadConfig()), dataDir: dir, x402FacilitatorUrl: proxyUrl };
    const first = createComputerUseApp(config, { driver: new FakeDesktopDriver(), quiet: true });
    const file = join(dir, "computer-use-key.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).address).toBe(first.locals.payTo);
    expect(createComputerUseApp(config, { driver: new FakeDesktopDriver(), quiet: true }).locals.payTo).toBe(first.locals.payTo);
    await first.locals.shutdown();
  });

  it("unknown routes → 404 JSON", async () => {
    const env = await start();
    expect(await call("GET", `${env.url}/computer/nope`)).toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});
