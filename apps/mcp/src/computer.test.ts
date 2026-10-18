import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig, toBaseUnits } from "@allowance/shared";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createComputerUseApp } from "../../computer-use/src/app.js";
import { loadComputerUseConfig } from "../../computer-use/src/config.js";
import { FakeDesktopDriver, TINY_JPEG } from "../../computer-use/src/test-desktop.js";
import { createServer } from "./server.js";

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}

/**
 * A wallet-service stand-in that really signs: /v1/pay signs the x402 challenge with the agent's key
 * (so the computer's paywall settles real mock-ledger USDC), /settled records the settlement.
 */
function walletStub() {
  const keys = new Map<string, ReturnType<typeof privateKeyToAccount>>();
  const blocked = new Set<string>();
  const pays: { token: string; url: string; description: string; amount: string }[] = [];
  const settled: string[] = [];
  let seq = 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!keys.has(token)) return void res.status(401).json({ error: "unauthorized", message: "bad token" });
    res.locals.token = token;
    next();
  });
  app.post("/v1/pay", async (req, res) => {
    const token = res.locals.token as string;
    const { paymentRequired, url, description } = req.body;
    const amount = (Number(paymentRequired.accepts[0].amount) / 1e6).toString();
    pays.push({ token, url, description, amount });
    if (blocked.has(token)) {
      return void res.status(403).json({ status: "blocked", reason: "service_not_connected", message: "Computer is not connected for tester. Ask the owner with request_service.", frozen: false });
    }
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(keys.get(token)!));
    const payload = await client.createPaymentPayload(paymentRequired);
    const paymentId = `pay_${++seq}`;
    res.json({ status: "approved", paymentId, paymentHeader: encodePaymentSignatureHeader(payload), receipt: { id: `rcp_${seq}`, status: "signed", amount, description } });
  });
  app.post("/v1/payments/:id/settled", (req, res) => {
    settled.push(String(req.params.id));
    const p = pays[Number(String(req.params.id).slice(4)) - 1];
    res.json({ receipt: { id: `rcp_${req.params.id}`, kind: "spend", status: "settled", amount: p?.amount, description: p?.description, txHash: req.body.settleResponse.transaction } });
  });
  return { app, keys, blocked, pays, settled };
}

describe("computer_* MCP tools (§19.6)", () => {
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];
  let facUrl: string;
  let walletUrl: string;
  let computerUrl: string;
  let driver: FakeDesktopDriver;
  const wallet = walletStub();
  const agentA = privateKeyToAccount(generatePrivateKey());
  const agentB = privateKeyToAccount(generatePrivateKey());
  const balance = async (addr: string) => BigInt(((await (await fetch(`${facUrl}/balance/${addr}`)).json()) as { balanceBaseUnits: string }).balanceBaseUnits);

  async function connect(token: string, computerTools = true) {
    const server = createServer({ walletServiceUrl: walletUrl, agentToken: token, approvalWaitMs: 200, log: () => {}, computerTools });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return { client, call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult };
  }

  beforeAll(async () => {
    const fac = createHttpServer(createFacilitatorApp({ ...loadConfig(), ownerApiKey: undefined, dataDir: mkdtempSync(join(tmpdir(), "allowance-fac-")) }, { quiet: true }));
    facUrl = await listen(fac);
    servers.push(fac);
    const w = createHttpServer(wallet.app);
    walletUrl = await listen(w);
    servers.push(w);
    const cs = createHttpServer();
    computerUrl = await listen(cs);
    servers.push(cs);
    driver = new FakeDesktopDriver();
    const app = createComputerUseApp(
      { ...loadComputerUseConfig({}, loadConfig()), chainMode: "mock", dataDir: mkdtempSync(join(tmpdir(), "allowance-cu-")), facilitatorUrl: facUrl, x402FacilitatorUrl: facUrl, computerUseUrl: computerUrl },
      { driver, quiet: true },
    );
    cs.on("request", app);
    closers.push(() => app.locals.shutdown());
    process.env.COMPUTER_USE_URL = computerUrl;
    for (const a of [agentA, agentB]) {
      await fetch(`${facUrl}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: a.address, amount: "2.00" }) });
    }
    wallet.keys.set("tok_a", agentA);
    wallet.keys.set("tok_b", agentB);
    wallet.keys.set("tok_c", privateKeyToAccount(generatePrivateKey()));
    wallet.blocked.add("tok_c");
  });

  afterAll(async () => {
    delete process.env.COMPUTER_USE_URL;
    for (const c of closers) await c();
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("the tools exist only when asked for (Claude Desktop), so chat agents keep their tool list", async () => {
    const plain = await connect("tok_a", false);
    expect((await plain.client.listTools()).tools.some((t) => t.name.startsWith("computer_"))).toBe(false);
    const withComputer = await connect("tok_a");
    const tools = (await withComputer.client.listTools()).tools.filter((t) => t.name.startsWith("computer_"));
    expect(tools.map((t) => t.name).sort()).toEqual(["computer_act", "computer_end", "computer_start", "computer_status", "computer_view"]);
    expect(tools.find((t) => t.name === "computer_start")!.description).toMatch(/\$0\.02 per minute/);
    expect(tools.find((t) => t.name === "computer_act")!.description).toMatch(/Never type card numbers or passwords/);
  });

  it("start, act, view (text and image), queue a second agent, end, and the second one starts — paid through the wallet", async () => {
    const a = await connect("tok_a");
    const b = await connect("tok_b");
    const before = await balance(agentA.address);

    const started = await a.call("computer_start", { label: "claude" });
    expect(started.isError, textOf(started)).toBeFalsy();
    expect(textOf(started)).toMatch(/^Computer session cus_[0-9a-f]+ is active with 60 s of time\. Paid \$0\.02\. Your owner can watch: http:\/\/127\.0\.0\.1:\d+\/computer\/sessions\/cus_[0-9a-f]+\/view\?token=cuv_/);
    expect(started.structuredContent).toMatchObject({ status: "active", lease: { secondsLeft: 60 } });
    expect(wallet.pays.at(-1)).toMatchObject({ token: "tok_a", description: "Computer use · 1 minute", amount: "0.02" });

    const nav = await a.call("computer_act", { action: "navigate", url: "https://example.com" });
    expect(textOf(nav)).toBe('Now at "Example Domain" https://example.com. Paid $0.005 · lease 60 s left.');
    const view = await a.call("computer_view");
    expect(view.content.every((c) => c.type === "text")).toBe(true);
    const t = textOf(view);
    expect(t).toContain('"Example Domain" https://example.com');
    expect(t).toContain("[1] More information…");
    expect(t).toContain('[1] link "More information…" at 200,300 (→ https://www.iana.org/domains/example)');
    expect(t).toContain('[4] textbox "Password" at 300,160 (type password)');
    expect(t).toContain("Text view paid $0.002");
    const both = await a.call("computer_view", { mode: "both" });
    expect(both.content[0]).toEqual({ type: "image", data: TINY_JPEG.toString("base64"), mimeType: "image/jpeg" });
    expect(textOf(both)).toMatch(/Screenshot paid \$0\.003 · Text view paid \$0\.002/);
    const click = await a.call("computer_act", { action: "click", element: 1 });
    expect(textOf(click)).toMatch(/^Now at "IANA" https:\/\/www\.iana\.org\/domains\/example\. Paid \$0\.005/);

    // A failure inside the desktop is not charged.
    const mid = await balance(agentA.address);
    const missing = await a.call("computer_act", { action: "click", element: 99 });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("click failed (element_not_found): There is no element 99 in the last snapshot. Nothing was charged.");
    expect(await balance(agentA.address)).toBe(mid);
    const card = await a.call("computer_act", { action: "type", element: 3, text: "4242 4242 4242 4242" });
    expect(textOf(card)).toMatch(/^type failed \(card_number_refused\): That looks like a card number/);

    const spent = toBaseUnits("0.02") + toBaseUnits("0.005") * 2n + toBaseUnits("0.002") * 2n + toBaseUnits("0.003");
    expect(before - (await balance(agentA.address))).toBe(spent);

    // A second agent waits in line, for free.
    const queued = await b.call("computer_start");
    expect(textOf(queued)).toMatch(/^In line for a seat: position 1 of 1, about \d+ s\. Waiting is free/);
    expect(queued.structuredContent).toMatchObject({ status: "queued", position: 1 });
    expect(textOf(await b.call("computer_status"))).toMatch(/^In line for a seat: position 1 of 1/);
    const bBefore = await balance(agentB.address);

    const ended = await a.call("computer_end");
    expect(textOf(ended)).toMatch(/^Ended computer session cus_[0-9a-f]+\. Spent \$0\.037 \(1 min, 2 actions, 3 views\)\.$/);
    await new Promise((r) => setTimeout(r, 10));
    expect(textOf(await b.call("computer_status"))).toMatch(/^Your seat is ready\. Call computer_start within \d+ s to buy the first minute/);
    const go = await b.call("computer_start", { minutes: 2 });
    expect(textOf(go)).toMatch(/is active with 120 s of time\. Paid \$0\.04\./);
    expect(bBefore - (await balance(agentB.address))).toBe(toBaseUnits("0.04"));
    expect(textOf(await a.call("computer_status"))).toBe("You have no computer session. Start one with computer_start.");
    await b.call("computer_end");

    // The session token never reaches the model.
    for (const r of [started, nav, view, click, missing, queued, ended, go]) expect(JSON.stringify(r)).not.toMatch(/cut_[0-9a-f]{48}/);
  });

  it("not connected: the wallet blocks the first minute, the tool says to request_service, and the seat is given back", async () => {
    const c = await connect("tok_c");
    const r = await c.call("computer_start");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('The Computer isn\'t connected yet. Ask your owner with request_service { "service_id": "computer-use", "reason": "…" }. Nothing was paid.');
    await new Promise((r2) => setTimeout(r2, 10));
    const index = (await (await fetch(`${computerUrl}/computer`)).json()) as { active: number; queued: number };
    expect(index).toMatchObject({ active: 0, queued: 0 });
  });
});
