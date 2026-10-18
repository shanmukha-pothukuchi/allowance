/**
 * The investing tools end to end: the real wallet-service (policy, its live re-fetch of the 402,
 * attestations, earnings checked against the ledger, cash out), the real paper brokerage and
 * directory, the real mock facilitator, and a stub Quantcomm. All on port 0.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { USDC_BASE_SEPOLIA, type AppConfig } from "@allowance/shared";
import { createServer } from "./server.js";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createApp, type WalletApp } from "../../wallet-service/src/app.js";
import { createDirectoryApp } from "../../directory/src/app.js";
import { createBrokerageApp, type BrokerageApp } from "../../brokerage/src/app.js";
import { CALENDAR, startStubQuantcomm, type StubQuantcomm } from "../../brokerage/src/test-quantcomm.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

const OWNER = "ok_mcp_invest_test";
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

let upstream: StubQuantcomm;
let wallet: WalletApp;
let broker: BrokerageApp;
const servers: Server[] = [];
let walletUrl: string;
let brokerUrl: string;
let facUrl: string;
const logs: string[] = [];

const owner = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(url, { method, headers: { "content-type": "application/json", "x-owner-key": OWNER }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const ledger = async (address: string) => ((await (await fetch(`${facUrl}/balance/${address}`)).json()) as { balance: string }).balance;

async function agent(name: string, services: string[], policy: Record<string, unknown>, initialBalance: string) {
  const r = await owner("POST", `${walletUrl}/v1/agents`, { name, services, initialBalance, policy: { allowlist: { addresses: [], origins: [] }, ...policy } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const server = createServer({ walletServiceUrl: walletUrl, agentToken: r.body.token, approvalWaitMs: 4000, log: (m) => logs.push(m) });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (tool: string, args: Record<string, unknown> = {}) => (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  return { id: r.body.agent.id as string, address: r.body.agent.address as string, call, client, close: async () => { await client.close(); await server.close(); } };
}

let investor: Awaited<ReturnType<typeof agent>>;
let outsider: Awaited<ReturnType<typeof agent>>;
let reckless: Awaited<ReturnType<typeof agent>>;

beforeAll(async () => {
  for (const level of ["log", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  upstream = await startStubQuantcomm();
  const dir = (p: string) => mkdtempSync(join(tmpdir(), p));

  const fac = createHttpServer(createFacilitatorApp({ dataDir: dir("allowance-fac-"), ownerApiKey: OWNER } as AppConfig, { quiet: true }));
  servers.push(fac);
  facUrl = await listen(fac);

  const brokerServer = createHttpServer();
  servers.push(brokerServer);
  brokerUrl = await listen(brokerServer);

  const directoryServer = createHttpServer();
  servers.push(directoryServer);
  const directoryUrl = await listen(directoryServer);
  directoryServer.on("request", createDirectoryApp({ merchantUrl: "http://127.0.0.1:1", directoryUrl, brokerageUrl: brokerUrl }));

  broker = createBrokerageApp(
    { chainMode: "mock", dataDir: dir("allowance-brokerage-"), brokerageUrl: brokerUrl, quantcommUrl: upstream.url, x402FacilitatorUrl: facUrl, facilitatorUrl: facUrl, baseSepoliaRpcUrl: "http://127.0.0.1:1", ownerApiKey: OWNER },
    { clock: { mode: "replay", replayFrom: START, daySeconds: 0 }, quiet: true },
  );
  brokerServer.on("request", broker);

  const config: AppConfig = {
    chainMode: "mock",
    repoRoot: process.cwd(),
    dataDir: dir("allowance-wallet-"),
    facilitatorPort: 0,
    facilitatorUrl: facUrl,
    walletServicePort: 0,
    walletServiceUrl: "",
    merchantPort: 0,
    merchantUrl: "http://127.0.0.1:1",
    dashboardPort: 0,
    directoryPort: 0,
    directoryUrl,
    baseSepoliaRpcUrl: "http://127.0.0.1:1",
    x402FacilitatorUrl: facUrl,
    network: "eip155:84532",
    usdcAddress: USDC_BASE_SEPOLIA,
    agentChatPort: 0,
    agentChatHost: "127.0.0.1",
    agentChatUrl: "",
    llm: { baseUrl: "http://127.0.0.1:1", model: "test" },
    shopifyBridgePort: 0,
    shopifyBridgeUrl: "http://127.0.0.1:1",
    shopify: { apiVersion: "2026-10" },
    nessie: { baseUrl: "https://api.nessieisreal.com", openingBalance: "5000.00" },
    quantcommBridgePort: 0,
    quantcommBridgeUrl: "http://127.0.0.1:1",
    quantcommUrl: upstream.url,
    brokeragePort: 0,
    brokerageUrl: brokerUrl,
    schedulerPort: 0,
    schedulerUrl: "http://127.0.0.1:1",
    ownerApiKey: OWNER,
  };
  // Defaults on purpose: the live 402 re-fetch and the live ledger lookup.
  wallet = createApp(config);
  const walletServer = createHttpServer(wallet.app);
  servers.push(walletServer);
  walletUrl = await listen(walletServer);

  investor = await agent("investor", ["brokerage"], { maxPerTx: "200.00", dailyCap: "1000.00", approvalThreshold: "150.00" }, "500.00");
  outsider = await agent("outsider", [], { maxPerTx: "200.00" }, "50.00");
  reckless = await agent("reckless", ["brokerage"], { maxPerTx: "20.00" }, "50.00");
});

afterAll(async () => {
  for (const a of [investor, outsider, reckless]) await a?.close();
  broker.locals.close();
  wallet.close();
  for (const s of servers) await close(s);
  await upstream.close();
  vi.restoreAllMocks();
});

describe("investing tools", () => {
  it("are registered with honest descriptions", async () => {
    const { tools } = await investor.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["get_quotes", "buy_stock", "sell_stock", "portfolio", "cash_out"]) expect(byName[name], name).toBeDefined();
    for (const name of ["get_quotes", "buy_stock", "sell_stock", "portfolio"]) expect(byName[name].description).toMatch(/Paper trading, not investment advice/);
    expect(byName.buy_stock.description).toMatch(/like fetch_url/);
    expect(byName.cash_out.description).toMatch(/back to your owner/);
  });

  it("get_quotes: prices at the replay date, labelled", async () => {
    const r = await investor.call("get_quotes", { tickers: ["cof", "JPM", "NOPE"] });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      [
        `Quotes · replay date ${START}`,
        `COF Capital One Financial Corp. $110.00 (+0.92% on the day, 0.00% since ${START})`,
        `JPM JPMorgan Chase & Co. $195.00 (-0.26% on the day, 0.00% since ${START})`,
        "No prices for: NOPE.",
        `${LABEL} (replay date ${START}) · not investment advice.`,
      ].join("\n"),
    );
    expect((await investor.call("get_quotes", { tickers: ["C$F"] })).isError).toBe(true);
  });

  it("buy_stock pays through the wallet (connected service, live 402 check) and books the shares", async () => {
    const r = await investor.call("buy_stock", { ticker: "COF", amount: "100" });
    expect(r.isError, textOf(r)).toBeFalsy();
    const lines = textOf(r).split("\n");
    expect(lines[0]).toBe("Bought 0.90909 COF for $100.00 at $110.00. You now hold 0.90909 COF (average cost $110.00).");
    expect(lines[1]).toMatch(/^Paid \$100\.00 to Brokerage \(paper\) · COF\. Receipt: tx 0x[0-9a-f]{4}…[0-9a-f]{4} \(http:\/\/127\.0\.0\.1:\d+\/tx\/0x[0-9a-f]{64}\)$/);
    expect(lines[2]).toBe(`${LABEL} (replay date ${START}) · not investment advice.`);
    expect(r.structuredContent).toMatchObject({ status: "bought", order: { ticker: "COF", shares: "0.90909", amount: "100.00" }, receipt: { kind: "spend", status: "settled", amount: "100.00" } });
    expect(await ledger(investor.address)).toBe("400.00");
    expect(broker.locals.book.account(investor.address)!.positions.COF.sharesMicro).toBe("909090");
  });

  it("buy_stock never pays for a failure, and stops where the wallet says", async () => {
    const before = wallet.store.state.receipts.length;
    const unknown = await investor.call("buy_stock", { ticker: "NOPE", amount: "10.00" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe("Not bought, nothing was charged: Quantcomm has no prices for NOPE. GET /brokerage lists the 4 tickers.");
    expect((await investor.call("buy_stock", { ticker: "COF", amount: "ten" })).isError).toBe(true);
    expect(wallet.store.state.receipts.length).toBe(before);

    const notConnected = await outsider.call("buy_stock", { ticker: "COF", amount: "10.00" });
    expect(textOf(notConnected)).toBe('Brokerage (paper) isn\'t connected yet. Ask your owner with request_service { service_id: "brokerage" }. Nothing was paid.');
    expect(await ledger(outsider.address)).toBe("50.00");

    const tooBig = await reckless.call("buy_stock", { ticker: "COF", amount: "25.00" });
    expect(tooBig.isError).toBe(true);
    expect(textOf(tooBig)).toMatch(/^Blocked by wallet policy \(max_per_tx\): .* You are now frozen; your owner has been notified\. Nothing was bought or paid\./);
    expect(await ledger(reckless.address)).toBe("50.00");
  });

  it("a buy over the approval threshold waits for the owner, then fills", async () => {
    const approver = (async () => {
      for (let i = 0; i < 100; i++) {
        const { body } = await owner("GET", `${walletUrl}/v1/approvals?status=pending`);
        const a = body.approvals.find((x: { agentName: string }) => x.agentName === "investor");
        if (a) return owner("POST", `${walletUrl}/v1/approvals/${a.id}/approve`, { by: "dashboard" });
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error("no approval appeared");
    })();
    const r = await investor.call("buy_stock", { ticker: "JPM", amount: "160.00" });
    expect((await approver).status).toBe(200);
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r).split("\n")[0]).toBe("Bought 0.820512 JPM for $160.00 at $195.00. You now hold 0.820512 JPM (average cost $195.00).");
    expect(logs.some((l) => /^buy JPM needs approval apr_[0-9a-f]+; waiting/.test(l))).toBe(true);
    expect(await ledger(investor.address)).toBe("240.00");
  });

  it("the price moves; portfolio and sell_stock: proceeds back to the wallet, recorded as an earning", async () => {
    expect((await owner("POST", `${brokerUrl}/brokerage/clock/advance`, { days: 11 })).body.clockDate).toBe(CALENDAR[21]);
    const p = await investor.call("portfolio");
    expect(textOf(p)).toBe(
      [
        `Portfolio · replay date ${CALENDAR[21]}`,
        "COF 0.90909 shares at $121.00 = $110.00 (cost $100.00, +$10.00, +10.00%)",
        "JPM 0.820512 shares at $189.50 = $155.49 (cost $160.00, -$4.51, -2.82%)",
        "Total $265.49 on $260.00 invested · unrealized +$5.49 (+2.11%) · realized $0.00.",
        "Cash is your wallet balance (get_wallet).",
        `${LABEL} (replay date ${CALENDAR[21]}) · not investment advice.`,
      ].join("\n"),
    );

    const s = await investor.call("sell_stock", { ticker: "cof" });
    expect(s.isError, textOf(s)).toBeFalsy();
    const lines = textOf(s).split("\n");
    expect(lines[0]).toBe("Sold 0.90909 COF for $109.99 at $121.00 · +$9.99 realized (+9.99% on a cost of $100.00). You hold no more COF.");
    expect(lines[1]).toMatch(/^Earned \$109\.99 for Sold 0\.90909 COF\. Receipt: tx 0x/);
    expect(lines[2]).toBe(`${LABEL} (replay date ${CALENDAR[21]}) · not investment advice.`);
    expect(s.structuredContent).toMatchObject({ status: "sold", order: { proceeds: "109.99", realizedPnl: "9.99" }, receipt: { kind: "earn", amount: "109.99", description: "Sold 0.90909 COF", counterparty: { name: "Brokerage (paper)" } } });
    expect(await ledger(investor.address)).toBe("349.99");
    const me = (await owner("GET", `${walletUrl}/v1/agents/${investor.id}`)).body.agent;
    expect(me.earnedToday).toBe("109.99");

    const again = await investor.call("sell_stock", { ticker: "COF" });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe("Nothing was sold: You hold no COF.");
    const tooMany = await investor.call("sell_stock", { ticker: "JPM", shares: "5" });
    expect(textOf(tooMany)).toBe("Nothing was sold: You hold 0.820512 JPM, not 5.");

    const after = await investor.call("portfolio");
    expect(textOf(after)).toContain("Total $155.49 on $160.00 invested · unrealized -$4.51 (-2.82%) · realized +$9.99.");
    // Another agent sees only its own (empty) portfolio.
    expect(textOf(await outsider.call("portfolio")).split("\n")[1]).toBe("No positions.");
  });

  it("cash_out moves USDC to the owner; everything when no amount; a frozen agent can't", async () => {
    const r = await investor.call("cash_out", { amount: "25.00" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/^Cashed out \$25\.00 to your owner\. Your balance is now \$324\.99\. Receipt: tx 0x/);
    const all = await investor.call("cash_out");
    expect(textOf(all)).toMatch(/^Cashed out \$324\.99 to your owner\. Your balance is now \$0\.00\./);
    expect(textOf(await investor.call("cash_out"))).toBe("Nothing to cash out: your balance is $0.00.");
    const vault = (await owner("GET", `${walletUrl}/v1/vault`)).body;
    expect(vault).toMatchObject({ balance: "349.99", cashedOut: "349.99", cashouts: 2 });
    const receipts = textOf(await investor.call("list_receipts", { limit: 3 }));
    expect(receipts).toContain("cashed out $324.99  Owner vault");

    // reckless was frozen by its blocked buy: only the owner can cash it out.
    expect(textOf(await reckless.call("cash_out"))).toBe("You're frozen, so only your owner can cash you out. Nothing moved.");
    expect((await owner("POST", `${walletUrl}/v1/agents/${reckless.id}/cashout`, { amount: "all" })).body).toMatchObject({ status: "sent", balance: "0.00" });
  });

  it("Quantcomm down: quotes and buys say so, nothing is charged", async () => {
    upstream.fail = "down";
    broker.locals.prices.clear();
    try {
      const q = await investor.call("get_quotes", { tickers: ["COF"] });
      expect(textOf(q)).toBe("No quotes: Prices aren't available right now: Quantcomm isn't answering. Nothing was charged.");
      const b = await outsider.call("buy_stock", { ticker: "COF", amount: "5.00" });
      expect(textOf(b)).toBe("Not bought, nothing was charged: Prices aren't available right now: Quantcomm isn't answering. Nothing was charged.");
    } finally {
      upstream.reset();
    }
  });
});
