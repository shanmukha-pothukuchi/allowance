import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import express from "express";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress } from "viem";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toBaseUnits, type AppConfig } from "@allowance/shared";
import { createSettlement, type Settlement } from "@allowance/wallet";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { attestationMessage, encodeAttestation } from "../../wallet-service/src/attest.js";
import { createBrokerageApp, DISCLAIMER, type BrokerageApp, type BrokerageConfig } from "./app.js";
import { cents, formatShares, parseShares, pctChange, sharesFor } from "./book.js";
import { clockSettingsFromEnv, ReplayClock, yearBefore, type ClockSettings } from "./clock.js";
import { CALENDAR, startStubQuantcomm, type StubQuantcomm } from "./test-quantcomm.js";

const OWNER = "ok_brokerage_test_owner_key";
const START = CALENDAR[10];
const LABEL = `Paper trading · replay of real closes from ${START}`;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonce = () => randomBytes(18).toString("base64url");

describe("book math", () => {
  it("fractional shares in millionths, money in cents", () => {
    expect(sharesFor(toBaseUnits("100.00"), toBaseUnits("201.74"))).toBe(495687n);
    expect(formatShares(495687n)).toBe("0.495687");
    expect(formatShares(3_200_000n)).toBe("3.2");
    expect(formatShares(3_000_000n)).toBe("3");
    expect(parseShares("1.5")).toBe(1_500_000n);
    expect(parseShares(0.25)).toBe(250_000n);
    for (const bad of ["0", "-1", "1.1234567", "abc", "", "1e3"]) expect(() => parseShares(bad), bad).toThrow();
    expect(cents(toBaseUnits("10.005"))).toBe("10.01");
    expect(cents(-toBaseUnits("10.005"))).toBe("-10.01");
    expect(cents(toBaseUnits("0.004"))).toBe("0.00");
    expect(pctChange(toBaseUnits("110"), toBaseUnits("100"))).toBe(10);
    expect(pctChange(toBaseUnits("95"), toBaseUnits("100"))).toBe(-5);
  });
});

describe("replay clock", () => {
  it("reads BROKERAGE_PRICES / BROKERAGE_REPLAY_FROM / BROKERAGE_DAY_SECONDS, falling back on bad values", () => {
    const quiet = () => {};
    expect(clockSettingsFromEnv({}, quiet)).toEqual({ mode: "replay", replayFrom: undefined, daySeconds: 20 });
    expect(clockSettingsFromEnv({ BROKERAGE_PRICES: "live", BROKERAGE_REPLAY_FROM: "2025-03-03", BROKERAGE_DAY_SECONDS: "5" }, quiet)).toEqual({ mode: "live", replayFrom: "2025-03-03", daySeconds: 5 });
    expect(clockSettingsFromEnv({ BROKERAGE_PRICES: "fast", BROKERAGE_REPLAY_FROM: "march", BROKERAGE_DAY_SECONDS: "0" }, quiet)).toEqual({ mode: "replay", replayFrom: undefined, daySeconds: 20 });
    expect(yearBefore("2026-10-16")).toBe("2025-10-16");
  });

  it("starts a year before the last close by default, moves one trading day at a time, stops at the last close", () => {
    const c = new ReplayClock({ mode: "replay", daySeconds: 20 });
    expect(c.date()).toBeNull();
    c.setCalendar(CALENDAR);
    const start = CALENDAR.find((d) => d >= yearBefore(CALENDAR.at(-1)!))!;
    expect(c.startDate()).toBe(start);
    expect(c.date()).toBe(start);
    expect(c.tick()).toBe(true);
    expect(c.date()).toBe(CALENDAR[CALENDAR.indexOf(start) + 1]);
    expect(c.advance(10_000)).toBe(CALENDAR.length - CALENDAR.indexOf(start) - 2);
    expect(c.date()).toBe(CALENDAR.at(-1));
    expect(c.view()).toMatchObject({ caughtUp: true, nextDayAt: null });
    expect(c.tick()).toBe(false);
  });

  it("resumes where it was after a restart (same setting); a changed setting restarts the replay", () => {
    const saved: unknown[] = [];
    const a = new ReplayClock({ mode: "replay", replayFrom: START, daySeconds: 20 }, { onChange: (s) => saved.push(s) });
    a.setCalendar(CALENDAR);
    a.advance(5);
    const snap = a.snapshot()!;
    expect(snap).toEqual({ replayFrom: START, startDate: START, date: CALENDAR[15] });
    expect(saved.at(-1)).toEqual(snap);
    const b = new ReplayClock({ mode: "replay", replayFrom: START, daySeconds: 20 }, { restored: snap });
    b.setCalendar(CALENDAR);
    expect(b.date()).toBe(CALENDAR[15]);
    const c = new ReplayClock({ mode: "replay", replayFrom: CALENDAR[20], daySeconds: 20 }, { restored: snap });
    c.setCalendar(CALENDAR);
    expect(c.date()).toBe(CALENDAR[20]);
    // A new close extends the calendar without moving the clock.
    b.setCalendar([...CALENDAR, "2099-01-01"]);
    expect(b.date()).toBe(CALENDAR[15]);
    expect(b.lastDate()).toBe("2099-01-01");
  });

  it("live mode is always the last close and can't be advanced", () => {
    const c = new ReplayClock({ mode: "live", daySeconds: 20 });
    c.setCalendar(CALENDAR);
    expect(c.date()).toBe(CALENDAR.at(-1));
    expect(c.advance(3)).toBe(0);
    expect(c.view().nextDayAt).toBeNull();
  });
});

describe("brokerage", () => {
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  const house = privateKeyToAccount(generatePrivateKey());

  let upstream: StubQuantcomm;
  let facServer: Server;
  let proxyServer: Server;
  let brokerServer: Server;
  let facUrl: string;
  let proxyUrl: string;
  let brokerUrl: string;
  let config: BrokerageConfig;
  let app: BrokerageApp;
  let realSettlement: Settlement;
  let failSettle = false;
  let supportedDown = false;
  let failPayout = false;

  const ownerHeaders = { "x-owner-key": OWNER, "content-type": "application/json" };
  const mint = (to: string, amount: string) =>
    fetch(`${facUrl}/admin/mint`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ to, amount }) });
  const balance = async (addr: string) => BigInt(((await (await fetch(`${facUrl}/balance/${addr}`)).json()) as { balanceBaseUnits: string }).balanceBaseUnits);
  const txs = async (addr: string) => ((await (await fetch(`${facUrl}/txs?address=${addr}&limit=100`)).json()) as { txs: { hash: string; from: string; to: string; amountBaseUnits: string; kind: string }[] }).txs;

  const get = async (path: string, headers: Record<string, string> = {}, base = brokerUrl) => {
    const r = await fetch(`${base}${path}`, { headers: { accept: "application/json", ...headers } });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}, base = brokerUrl) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  /** Pays with the official x402 client (no $1 cap). */
  const buy = async (who: PrivateKeyAccount, query: string, base = brokerUrl, init: RequestInit = {}) => {
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(who)).setSpendControls(false);
    const r = await wrapFetchWithPayment(fetch, client)(`${base}/brokerage/orders/buy?${query}`, { method: "POST", headers: { accept: "application/json", ...(init.headers ?? {}) }, body: init.body });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  const bought = async (who: PrivateKeyAccount, query: string) => {
    const r = await buy(who, query);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  /** The wallet's attestation, made here with the agent's own key (same text the wallet signs). */
  const attest = async (who: PrivateKeyAccount, opts: { audience?: string; issuedAt?: string; nonce?: string; address?: `0x${string}` } = {}) => {
    const a = { address: opts.address ?? who.address, audience: opts.audience ?? `${brokerUrl}/brokerage`, nonce: opts.nonce ?? nonce(), issuedAt: opts.issuedAt ?? new Date().toISOString() };
    const signature = await who.signMessage({ message: attestationMessage(a) });
    return { "x-allowance-attestation": encodeAttestation({ ...a, signature }) };
  };
  const sell = async (who: PrivateKeyAccount, body: unknown) => post("/brokerage/orders/sell", body, await attest(who));
  const portfolio = async (who: PrivateKeyAccount) => get("/brokerage/portfolio", await attest(who));
  const advance = (days: number) => post("/brokerage/clock/advance", { days }, { "x-owner-key": OWNER });
  /** Every failure answers before the paywall: no 402, and a paying client is not charged. */
  const refused = async (query: string, status: number, error: string, init: RequestInit = {}) => {
    const before = await balance(alice.address);
    const unpaid = await post(`/brokerage/orders/buy?${query}`, init.body ? JSON.parse(String(init.body)) : undefined);
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(status);
    expect(unpaid.body.error).toBe(error);
    expect(unpaid.headers.get("payment-required")).toBeNull();
    const paying = await buy(alice, query, brokerUrl, { ...init, headers: init.body ? { "content-type": "application/json" } : {} });
    expect(paying.status).toBe(status);
    expect(await balance(alice.address)).toBe(before);
    return unpaid.body;
  };

  const newApp = (over: Partial<BrokerageConfig> = {}, clock: Partial<ClockSettings> = { mode: "replay", replayFrom: START, daySeconds: 0 }, account: PrivateKeyAccount = house) =>
    createBrokerageApp({ ...config, dataDir: mkdtempSync(join(tmpdir(), "allowance-brokerage-")), ...over }, {
      account,
      settlement: { mode: "mock", balanceOf: (a) => realSettlement.balanceOf(a), transfer: (...args) => (failPayout ? Promise.reject(new Error("settle failed: insufficient_funds")) : realSettlement.transfer(...args)) },
      clock,
      quiet: true,
      facilitatorRetryMs: 20,
    });

  beforeAll(async () => {
    upstream = await startStubQuantcomm();
    const facApp = createFacilitatorApp({ dataDir: mkdtempSync(join(tmpdir(), "allowance-fac-")), ownerApiKey: OWNER } as AppConfig, { quiet: true });
    facServer = createServer(facApp);
    facUrl = await listen(facServer);
    realSettlement = createSettlement({ chainMode: "mock", facilitatorUrl: facUrl, baseSepoliaRpcUrl: "http://127.0.0.1:1" });

    const proxy = express();
    proxy.use(express.json());
    proxy.get("/supported", async (_req, res) => {
      if (supportedDown) return void res.status(503).json({ error: "starting" });
      res.json(await (await fetch(`${facUrl}/supported`)).json());
    });
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

    brokerServer = createServer();
    brokerUrl = await listen(brokerServer);
    config = {
      chainMode: "mock",
      dataDir: "",
      brokerageUrl: brokerUrl,
      quantcommUrl: upstream.url,
      x402FacilitatorUrl: proxyUrl,
      facilitatorUrl: facUrl,
      baseSepoliaRpcUrl: "http://127.0.0.1:1",
      ownerApiKey: OWNER,
    };
    app = newApp();
    brokerServer.on("request", app);
    await mint(alice.address, "2000.00");
    await mint(bob.address, "2000.00");
  });

  afterAll(async () => {
    app.locals.close();
    await close(brokerServer);
    await close(proxyServer);
    await close(facServer);
    await upstream.close();
  });

  beforeEach(() => {
    upstream.reset();
    app.locals.prices.clear();
    failSettle = false;
    supportedDown = false;
    failPayout = false;
  });

  describe("free", () => {
    it("GET /brokerage: replay dates, the tickers, the endpoints, and the honest labels", async () => {
      const r = await get("/brokerage");
      expect(r.status).toBe(200);
      expect(r.headers.get("payment-required")).toBeNull();
      expect(r.body).toMatchObject({ name: "Brokerage (paper)", provider: "Allowance", mode: "replay", clockDate: START, startDate: START, lastDate: CALENDAR.at(-1), label: LABEL, disclaimer: DISCLAIMER, fees: "none", minOrder: "1.00", maxOrder: "1000.00" });
      expect(DISCLAIMER).toMatch(/Not investment advice/);
      expect(r.body.tickers).toEqual([
        { ticker: "SPY", name: "SPDR S&P 500 ETF", group: "ETFs" },
        { ticker: "COF", name: "Capital One Financial Corp.", group: "Large banks" },
        { ticker: "JPM", name: "JPMorgan Chase & Co.", group: "Large banks" },
        { ticker: "LATE", name: "Late Listing Inc.", group: "Regional" },
      ]);
      expect(r.body.endpoints.map((e: { url: string }) => e.url)).toContain(`${brokerUrl}/brokerage/orders/buy?ticker=COF&amount=100.00`);
    });

    it("GET /brokerage/quotes: prices at the clock's date, 1-day change and change from the replay start", async () => {
      const r = await get("/brokerage/quotes?tickers=cof,JPM,NOPE");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ mode: "replay", clockDate: START, startDate: START, label: LABEL, disclaimer: DISCLAIMER, unknown: ["NOPE"] });
      expect(r.body.quotes).toEqual([
        { ticker: "COF", name: "Capital One Financial Corp.", group: "Large banks", price: "110.00", priceDate: START, changePct1d: 0.92, changePctFromStart: 0 },
        { ticker: "JPM", name: "JPMorgan Chase & Co.", group: "Large banks", price: "195.00", priceDate: START, changePct1d: -0.26, changePctFromStart: 0 },
      ]);
      expect((await get("/brokerage/quotes?tickers=NOPE")).body.error).toBe("ticker_not_found");
      for (const bad of ["", "?tickers=", "?tickers=C$F", `?tickers=${Array.from({ length: 21 }, (_v, i) => `T${i}`).join(",")}`]) {
        expect((await get(`/brokerage/quotes${bad}`)).status, bad).toBe(400);
      }
      // A ticker whose history starts after the clock's date has no price yet.
      expect(await get("/brokerage/quotes?tickers=LATE")).toMatchObject({ status: 404, body: { error: "no_price" } });
    });
  });

  describe("buy (x402, price = amount)", () => {
    it("unpaid → 402 for exactly the amount to the brokerage wallet; the wallet's re-fetch (same URL, no body) sees the same", async () => {
      for (const init of [{}, { body: JSON.stringify({ ticker: "COF", amount: "25.50" }), headers: { "content-type": "application/json" } }]) {
        const r = await fetch(`${brokerUrl}/brokerage/orders/buy?ticker=COF&amount=25.50`, { method: "POST", headers: { accept: "application/json", ...(init.headers ?? {}) }, body: init.body });
        expect(r.status).toBe(402);
        const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
        expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "25500000", maxTimeoutSeconds: 300 });
        expect(getAddress(pr.accepts[0].payTo)).toBe(house.address);
        expect(pr.resource).toMatchObject({ description: "Brokerage (paper)" });
      }
    });

    it("buys fractional shares at the clock's price; the USDC moves to the brokerage; the position is booked once settled", async () => {
      const aliceBefore = await balance(alice.address);
      const houseBefore = await balance(house.address);
      const body = await bought(alice, "ticker=COF&amount=100.00");
      expect(body).toMatchObject({ side: "buy", ticker: "COF", name: "Capital One Financial Corp.", shares: "0.90909", price: "110.00", amount: "100.00", clockDate: START, status: "filled", label: LABEL, disclaimer: DISCLAIMER });
      expect(body.orderId).toMatch(/^ord_/);
      expect(aliceBefore - (await balance(alice.address))).toBe(toBaseUnits("100.00"));
      expect((await balance(house.address)) - houseBefore).toBe(toBaseUnits("100.00"));
      const p = (await portfolio(alice)).body;
      expect(p.positions).toEqual([
        { ticker: "COF", name: "Capital One Financial Corp.", shares: "0.90909", avgCost: "110.00", price: "110.00", priceDate: START, value: "100.00", costBasis: "100.00", unrealizedPnl: "0.00", unrealizedPct: 0, changePct1d: 0.92 },
      ]);
      expect(p.orders[0]).toMatchObject({ side: "buy", ticker: "COF", shares: "0.90909", amount: "100.00", status: "filled" });
      expect(p.orders[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("never charged for a failure: unknown ticker, bad amounts, the order only in the body, a body that disagrees", async () => {
      expect((await refused("ticker=NOPE&amount=10.00", 404, "ticker_not_found")).message).toMatch(/GET \/brokerage lists/);
      await refused("ticker=C$F&amount=10.00", 400, "invalid_ticker");
      for (const amount of ["0.50", "1000.01", "abc", "10.005", "-5", ""]) await refused(`ticker=COF&amount=${amount}`, 400, "invalid_amount");
      await refused("ticker=LATE&amount=10.00", 404, "no_price");
      await refused("x=1", 400, "order_in_query", { body: JSON.stringify({ ticker: "COF", amount: "10.00" }) });
      await refused("ticker=COF&amount=10.00", 400, "order_mismatch", { body: JSON.stringify({ ticker: "COF", amount: "99.00" }) });
    });

    it("Quantcomm down → 503 prices_unavailable; a changed shape → 502 quantcomm_changed; both before the paywall", async () => {
      upstream.fail = "down";
      app.locals.prices.clear();
      expect((await refused("ticker=COF&amount=10.00", 503, "prices_unavailable")).message).toBe("Prices aren't available right now: Quantcomm isn't answering. Nothing was charged.");
      expect((await get("/brokerage/quotes?tickers=COF")).status).toBe(503);
      expect((await get("/health")).body).toMatchObject({ ok: true, upstream: "down" });
      upstream.fail = 500;
      app.locals.prices.clear();
      await refused("ticker=COF&amount=10.00", 503, "prices_unavailable");
      upstream.reset();
      upstream.histories.COF.closes = upstream.histories.COF.closes.slice(1);
      app.locals.prices.clear();
      const changed = await refused("ticker=COF&amount=10.00", 502, "quantcomm_changed");
      expect(changed.details.where).toMatch(/differ in length/);
    });

    it("settlement fails → nothing charged, nothing booked", async () => {
      const before = await balance(alice.address);
      const held = app.locals.book.account(alice.address)?.positions.JPM;
      failSettle = true;
      const r = await buy(alice, "ticker=JPM&amount=50.00");
      expect(r.status).toBe(402);
      expect(r.body.error).toBe("payment_not_settled");
      expect(await balance(alice.address)).toBe(before);
      expect(app.locals.book.account(alice.address)?.positions.JPM).toEqual(held);
    });

    it("a facilitator that starts after the brokerage: the first buy works once it's up", async () => {
      supportedDown = true;
      const late = newApp();
      const s = createServer(late);
      const url = await listen(s);
      await sleep(60);
      supportedDown = false;
      await sleep(150);
      const r = await buy(bob, "ticker=SPY&amount=5.00", url);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      late.locals.close();
      await close(s);
    });
  });

  describe("price moves, sells and P/L", () => {
    it("buy, the replay moves 11 trading days (+10%), sell all: proceeds paid in USDC, realized profit", async () => {
      const a = newApp();
      const s = createServer(a);
      const url = await listen(s);
      const at = (path: string) => `${url}${path}`;
      try {
        const client = new x402Client().register("eip155:84532", new ExactEvmScheme(bob)).setSpendControls(false);
        const r = await wrapFetchWithPayment(fetch, client)(at("/brokerage/orders/buy?ticker=COF&amount=110.00"), { method: "POST" });
        expect(r.status).toBe(200);
        expect(((await r.json()) as any).shares).toBe("1");

        const adv = await fetch(at("/brokerage/clock/advance"), { method: "POST", headers: ownerHeaders, body: JSON.stringify({ days: 11 }) });
        expect(await adv.json()).toMatchObject({ moved: 11, clockDate: CALENDAR[21], startDate: START });

        const audience = `${url}/brokerage`;
        const pf = await fetch(at("/brokerage/portfolio"), { headers: await attest(bob, { audience }) });
        const p = (await pf.json()) as any;
        expect(p).toMatchObject({ address: bob.address, clockDate: CALENDAR[21], startDate: START, label: LABEL, disclaimer: DISCLAIMER, cash: null });
        expect(p.positions).toEqual([
          { ticker: "COF", name: "Capital One Financial Corp.", shares: "1", avgCost: "110.00", price: "121.00", priceDate: CALENDAR[21], value: "121.00", costBasis: "110.00", unrealizedPnl: "11.00", unrealizedPct: 10, changePct1d: 0.83 },
        ]);
        expect(p.totals).toEqual({ invested: "110.00", value: "121.00", unrealizedPnl: "11.00", unrealizedPct: 10, realizedPnl: "0.00", totalPnl: "11.00" });

        const before = await balance(bob.address);
        const sold = await fetch(at("/brokerage/orders/sell"), { method: "POST", headers: { "content-type": "application/json", ...(await attest(bob, { audience })) }, body: JSON.stringify({ ticker: "COF", shares: "all" }) });
        const body = (await sold.json()) as any;
        expect(sold.status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({ side: "sell", ticker: "COF", shares: "1", price: "121.00", proceeds: "121.00", costBasis: "110.00", realizedPnl: "11.00", realizedPct: 10, clockDate: CALENDAR[21], position: null, label: LABEL, disclaimer: DISCLAIMER });
        expect(getAddress(body.from)).toBe(house.address);
        expect((await balance(bob.address)) - before).toBe(toBaseUnits("121.00"));
        // The payout is a plain ledger transfer brokerage → agent for the exact proceeds: what /v1/earnings checks.
        const tx = (await txs(bob.address)).find((t) => t.hash === body.payoutTx)!;
        expect(tx).toMatchObject({ from: house.address, to: bob.address, amountBaseUnits: "121000000", kind: "settle" });
        expect(body.explorerUrl).toBe(`${facUrl}/tx/${body.payoutTx}`);

        const after = (await (await fetch(at("/brokerage/portfolio"), { headers: await attest(bob, { audience }) })).json()) as any;
        expect(after.positions).toEqual([]);
        expect(after.totals).toEqual({ invested: "0.00", value: "0.00", unrealizedPnl: "0.00", unrealizedPct: 0, realizedPnl: "11.00", totalPnl: "11.00" });
        expect(after.orders.map((o: { side: string }) => o.side)).toEqual(["sell", "buy"]);
      } finally {
        a.locals.close();
        await close(s);
      }
    });

    it("partial sells: proportional cost basis, unrealized P/L on what is left, a loss when the price fell", async () => {
      await bought(alice, "ticker=JPM&amount=100.00"); // 195.00 → 0.512820 shares
      const before = app.locals.book.account(alice.address)!.positions.JPM;
      expect(before.sharesMicro).toBe("512820");
      expect((await advance(20)).body.clockDate).toBe(CALENDAR[30]); // JPM 185.00, COF 130.00
      const r = await sell(alice, { ticker: "JPM", shares: "0.25" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // 0.25 × 185.00 = 46.25; cost 100 × 0.25 / 0.51282 = 48.75 → −2.50
      expect(r.body).toMatchObject({ shares: "0.25", price: "185.00", proceeds: "46.25", costBasis: "48.75", realizedPnl: "-2.50", position: { ticker: "JPM", shares: "0.26282", costBasis: "51.25" } });
      const p = (await portfolio(alice)).body;
      const jpm = p.positions.find((x: { ticker: string }) => x.ticker === "JPM");
      expect(jpm).toMatchObject({ shares: "0.26282", price: "185.00", value: "48.62", costBasis: "51.25", unrealizedPnl: "-2.63" });
      expect(jpm.unrealizedPct).toBeCloseTo(-5.13, 2);
      const cof = p.positions.find((x: { ticker: string }) => x.ticker === "COF");
      expect(cof).toMatchObject({ shares: "0.90909", price: "130.00", value: "118.18", unrealizedPnl: "18.18", unrealizedPct: 18.18 });
      expect(p.totals.realizedPnl).toBe("-2.50");
    });

    it("sell errors change nothing: no position, more than held, bad shares, dust, a payout that fails", async () => {
      const held = { ...app.locals.book.account(alice.address)!.positions.JPM };
      expect(await sell(alice, { ticker: "SPY", shares: "all" })).toMatchObject({ status: 404, body: { error: "no_position" } });
      expect(await sell(alice, { ticker: "JPM", shares: "5" })).toMatchObject({ status: 400, body: { error: "insufficient_shares", held: "0.26282" } });
      for (const shares of ["-1", "abc", "0", undefined]) expect((await sell(alice, { ticker: "JPM", shares })).body.error, String(shares)).toBe("invalid_shares");
      expect((await sell(alice, { ticker: "JPM", shares: "0.000001" })).body.error).toBe("order_too_small");
      const before = await balance(alice.address);
      failPayout = true;
      expect(await sell(alice, { ticker: "JPM", shares: "all" })).toMatchObject({ status: 502, body: { error: "payout_failed" } });
      expect(await balance(alice.address)).toBe(before);
      expect(app.locals.book.account(alice.address)!.positions.JPM).toMatchObject({ sharesMicro: held.sharesMicro, costUnits: held.costUnits });
    });

    it("the float: a profit bigger than the wallet's balance is minted (owner key) before the payout", async () => {
      const empty = privateKeyToAccount(generatePrivateKey());
      const a = newApp({}, undefined, empty);
      const s = createServer(a);
      const url = await listen(s);
      const fresh = privateKeyToAccount(generatePrivateKey());
      await mint(fresh.address, "50.00");
      try {
        const client = new x402Client().register("eip155:84532", new ExactEvmScheme(fresh)).setSpendControls(false);
        expect((await wrapFetchWithPayment(fetch, client)(`${url}/brokerage/orders/buy?ticker=COF&amount=11.00`, { method: "POST" })).status).toBe(200);
        await fetch(`${url}/brokerage/clock/advance`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ days: 400 }) });
        const r = await fetch(`${url}/brokerage/orders/sell`, { method: "POST", headers: { "content-type": "application/json", ...(await attest(fresh, { audience: `${url}/brokerage` })) }, body: JSON.stringify({ ticker: "COF", shares: "all" }) });
        const body = (await r.json()) as any;
        expect(r.status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({ price: "399.00", proceeds: "39.90", realizedPnl: "28.90" }); // 0.1 share bought at 110
        // It held $11.00 (the buy); it minted $28.90 + $1000.00, then paid $39.90.
        expect(await balance(empty.address)).toBe(toBaseUnits("1000.00"));
        expect((await txs(empty.address)).filter((t) => t.kind === "mint").map((t) => t.amountBaseUnits)).toEqual(["1028900000"]);
      } finally {
        a.locals.close();
        await close(s);
      }
    });
  });

  describe("who: one agent can never sell another agent's shares", () => {
    it("portfolio and sell need an attestation", async () => {
      expect(await get("/brokerage/portfolio")).toMatchObject({ status: 401, body: { error: "attestation_required" } });
      expect(await post("/brokerage/orders/sell", { ticker: "COF", shares: "all" })).toMatchObject({ status: 401, body: { error: "attestation_required" } });
      expect((await get("/brokerage/portfolio", { "x-allowance-attestation": "bm9wZQ" })).status).toBe(401);
    });

    it("bob can't sell alice's shares: his own attestation finds no position; a forged one (alice's address, bob's key) is refused", async () => {
      const held = { ...app.locals.book.account(alice.address)!.positions.COF };
      expect(held.sharesMicro).toBe("909090");
      expect(await sell(bob, { ticker: "COF", shares: "all" })).toMatchObject({ status: 404, body: { error: "no_position" } });
      const forged = await attest(bob, { address: alice.address });
      const r = await post("/brokerage/orders/sell", { ticker: "COF", shares: "all" }, forged);
      expect(r).toMatchObject({ status: 401, body: { error: "attestation_required" } });
      expect(r.body.message).toMatch(/signature does not match/);
      expect((await get("/brokerage/portfolio", await attest(bob, { address: alice.address }))).status).toBe(401);
      expect(app.locals.book.account(alice.address)!.positions.COF).toMatchObject({ sharesMicro: held.sharesMicro, costUnits: held.costUnits });
      // And bob's portfolio is his own.
      expect((await portfolio(bob)).body.positions.map((p: { ticker: string }) => p.ticker)).not.toContain("COF");
    });

    it("an attestation is single use, fresh, and only for this brokerage", async () => {
      const once = await attest(alice);
      expect((await get("/brokerage/portfolio", once)).status).toBe(200);
      const again = await get("/brokerage/portfolio", once);
      expect(again.status).toBe(401);
      expect(again.body.message).toMatch(/already used/);
      const old = await get("/brokerage/portfolio", await attest(alice, { issuedAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
      expect(old.body.message).toMatch(/expired/);
      const elsewhere = await get("/brokerage/portfolio", await attest(alice, { audience: "http://localhost:4021/brokerage" }));
      expect(elsewhere.body.message).toMatch(/not this service/);
      // Loopback aliases of this brokerage are the same audience.
      const alias = brokerUrl.replace("127.0.0.1", "localhost");
      expect((await get("/brokerage/portfolio", await attest(alice, { audience: `${alias}/brokerage` }))).status).toBe(200);
    });

    it("the owner reads any portfolio by address (and every portfolio); never without the key", async () => {
      expect((await get(`/brokerage/portfolio?address=${alice.address}`)).status).toBe(401);
      expect((await get(`/brokerage/portfolio?address=${alice.address}`, { "x-owner-key": "wrong" })).status).toBe(401);
      const one = await get(`/brokerage/portfolio?address=${alice.address}`, { "x-owner-key": OWNER });
      expect(one.status).toBe(200);
      expect(one.body.positions.map((p: { ticker: string }) => p.ticker)).toEqual(["COF", "JPM"]);
      expect((await get("/brokerage/portfolio?address=nope", { "x-owner-key": OWNER })).body.error).toBe("invalid_address");
      const all = await get("/brokerage/portfolios", { "x-owner-key": OWNER });
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({ label: LABEL, disclaimer: DISCLAIMER });
      expect(all.body.portfolios.map((p: { address: string }) => p.address)).toContain(alice.address);
      expect((await get("/brokerage/portfolios")).status).toBe(401);
      expect((await post("/brokerage/clock/advance", { days: 1 })).status).toBe(401);
      expect((await post("/brokerage/clock/advance", { days: 0 }, { "x-owner-key": OWNER })).body.error).toBe("invalid_days");
    });
  });

  describe("persistence and modes", () => {
    it("the book and the clock survive a restart; the wallet key is generated once (0600)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "allowance-brokerage-restart-"));
      const first = createBrokerageApp({ ...config, dataDir: dir }, { clock: { mode: "replay", replayFrom: START, daySeconds: 0 }, quiet: true, settlement: realSettlement });
      const keyFile = join(dir, "brokerage-key.json");
      expect(existsSync(keyFile)).toBe(true);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(keyFile, "utf8")).address).toBe(first.locals.payTo);
      await first.locals.ready();
      first.locals.clock.advance(7);
      first.locals.book.addShares(alice.address, "COF", 1_000_000n, toBaseUnits("110"), new Date().toISOString());
      first.locals.book.save();
      first.locals.close();
      const second = createBrokerageApp({ ...config, dataDir: dir }, { clock: { mode: "replay", replayFrom: START, daySeconds: 0 }, quiet: true, settlement: realSettlement });
      expect(second.locals.payTo).toBe(first.locals.payTo);
      await second.locals.ready();
      expect(second.locals.clock.date()).toBe(CALENDAR[17]);
      expect(second.locals.book.account(alice.address)!.positions.COF.sharesMicro).toBe("1000000");
      second.locals.close();
    });

    it("live mode: the latest real close, labelled so; no replay to advance", async () => {
      const live = newApp({}, { mode: "live", replayFrom: START, daySeconds: 0 });
      const s = createServer(live);
      const url = await listen(s);
      try {
        const q = await get("/brokerage/quotes?tickers=COF", {}, url);
        expect(q.body).toMatchObject({ mode: "live", clockDate: CALENDAR.at(-1), label: `Paper trading · latest real close (${CALENDAR.at(-1)})` });
        expect(q.body.quotes[0].price).toBe(`${100 + CALENDAR.length - 1}.00`);
        expect((await post("/brokerage/clock/advance", { days: 1 }, { "x-owner-key": OWNER }, url)).body.error).toBe("not_replaying");
      } finally {
        live.locals.close();
        await close(s);
      }
    });

    it("the replay moves by itself every BROKERAGE_DAY_SECONDS", async () => {
      const timed = newApp({}, { mode: "replay", replayFrom: START, daySeconds: 1 });
      try {
        await timed.locals.ready();
        expect(timed.locals.clock.date()).toBe(START);
        await sleep(1150);
        expect(timed.locals.clock.date()).toBe(CALENDAR[11]);
      } finally {
        timed.locals.close();
      }
    });

    it("Quantcomm is only ever read with GET; unknown routes are 404 JSON", async () => {
      expect(upstream.requests.length).toBeGreaterThan(5);
      expect(upstream.requests.filter((r) => r.method !== "GET")).toEqual([]);
      expect(upstream.requests.filter((r) => /advice\/run/.test(r.path))).toEqual([]);
      expect(await get("/brokerage/orders")).toMatchObject({ status: 404, body: { error: "not_found" } });
      expect((await get("/brokerage/orders/buy?ticker=COF&amount=10.00")).status).toBe(404);
    });
  });
});
