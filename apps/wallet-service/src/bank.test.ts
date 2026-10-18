/**
 * Capital One behind Allowance (docs/ARCHITECTURE.md §16): the wallet against a fake Nessie API,
 * the stub facilitator and nothing else, all on port 0. No real Nessie key is ever used.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { startStubFacilitator } from "@allowance/wallet/testing";
import type { StubFacilitator } from "@allowance/wallet/testing";
import { USDC_BASE_SEPOLIA, localDayKey, toBaseUnits } from "@allowance/shared";
import type { AppConfig, BankStatementResponse, BankSummary, ConnectedService, Policy, Receipt, WalletEvent, X402PaymentRequired } from "@allowance/shared";
import { createApp } from "./app.js";
import type { AppDeps, LookupTx, WalletApp } from "./app.js";
import { NessieClient } from "./bank.js";
import { startFakeNessie } from "./test-nessie.js";
import type { FakeNessie } from "./test-nessie.js";

const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OWNER_KEY = "ok_bank_test";
const MERCHANT = "http://localhost:4021";
const PAY_TO = "0x9999999999999999999999999999999999999999";
const OWNER_ADDRESS = { street_number: "1", street_name: "Demo Way", city: "College Park", state: "MD", zip: "20742" };
const TODAY = localDayKey();

let facilitator: StubFacilitator;
let nessie: FakeNessie;
let wallet: WalletApp;
let base: string;
let baseConfig: AppConfig;
const servers: Server[] = [];
const dirs: string[] = [];
const logs: string[] = [];
/** Every response body, for the "the key never leaves" assertion. */
const bodies: string[] = [];

const lookupTx: LookupTx = async (hash) => {
  const tx = facilitator.txs.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
  return tx ? { hash: tx.hash, from: tx.from, to: tx.to, amountBaseUnits: tx.amountBaseUnits } : null;
};
/** Fast but faithful: tiny write gap and retry delays, a short top-up budget. */
const deps = (): AppDeps => ({
  verifyChallenge: async () => ({ ok: true }),
  lookupTx,
  bank: { minWriteGapMs: 5, retryDelaysMs: [20, 20, 20, 20, 20], topupTimeoutMs: 1500, callTimeoutMs: 1000, balanceTtlMs: 0 },
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function listen(w: WalletApp): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = w.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string; at?: string } = {}) {
  const res = await fetch(`${opts.at ?? base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : { "x-owner-key": OWNER_KEY }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function createAgent(name: string, policy: Partial<Policy> = {}, initialBalance: string | null = "20.00", at?: string) {
  const r = await call("POST", "/v1/agents", { at, body: { name, policy: { allowlist: null, maxPerTx: "20.00", approvalThreshold: "10.00", ...policy }, ...(initialBalance ? { initialBalance } : {}) } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { agent: { id: string; name: string; address: `0x${string}` }; token: string };
}

function paymentRequired(amount: string, url: string, description: string): X402PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, description },
    accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC_BASE_SEPOLIA, amount: toBaseUnits(amount).toString(), payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }],
  };
}

/** Sign, settle on the stub facilitator (as the merchant would), report → the settled receipt. */
async function paySettled(token: string, from: string, amount: string, url = `${MERCHANT}/api/weather?city=Paris`, description = "Acme Weather", at?: string): Promise<Receipt> {
  const pr = paymentRequired(amount, url, description);
  const pay = await call("POST", "/v1/pay", { at, token, body: { paymentRequired: pr, url } });
  expect(pay.status, JSON.stringify(pay.body)).toBe(200);
  const paymentPayload = decodePaymentSignatureHeader(pay.body.paymentHeader);
  const settle = (await (
    await fetch(`${facilitator.url}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: pr.accepts[0] }) })
  ).json()) as { success: boolean; transaction: string };
  expect(settle.success).toBe(true);
  const settled = await call("POST", `/v1/payments/${pay.body.paymentId}/settled`, { at, token, body: { settleResponse: { success: true, transaction: settle.transaction, network: "eip155:84532", payer: from } } });
  expect(settled.status).toBe(200);
  return settled.body.receipt as Receipt;
}

const receipt = (w: WalletApp, id: string) => w.store.receiptById(id)!;
const events = (w: WalletApp, type?: WalletEvent["type"]) => w.store.state.events.filter((e) => !type || e.type === type);
const accountOf = (w: WalletApp, agentId: string) => w.bank.state.accounts[agentId];
const balance = async (token: string) => (await call("GET", "/v1/me", { token })).body.agent.balance as string;

beforeAll(async () => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  facilitator = await startStubFacilitator();
  nessie = await startFakeNessie({ key: KEY });
  baseConfig = {
    chainMode: "mock",
    repoRoot: process.cwd(),
    dataDir: tmp("allowance-bank-"),
    facilitatorPort: 0,
    facilitatorUrl: facilitator.url,
    walletServicePort: 0,
    walletServiceUrl: "",
    merchantPort: 4021,
    merchantUrl: MERCHANT,
    dashboardPort: 4040,
    directoryPort: 0,
    directoryUrl: "http://127.0.0.1:1",
    baseSepoliaRpcUrl: "http://127.0.0.1:1",
    x402FacilitatorUrl: facilitator.url,
    network: "eip155:84532",
    usdcAddress: USDC_BASE_SEPOLIA,
    agentChatPort: 0,
    agentChatHost: "127.0.0.1",
    agentChatUrl: "",
    llm: { baseUrl: "http://127.0.0.1:1", model: "test" },
    shopifyBridgePort: 0,
    shopifyBridgeUrl: "http://127.0.0.1:1",
    shopify: { apiVersion: "2026-10" },
    nessie: { apiKey: KEY, baseUrl: nessie.url, openingBalance: "5000.00" },
    quantcommBridgePort: 0,
    quantcommBridgeUrl: "http://127.0.0.1:1",
    quantcommUrl: "http://127.0.0.1:1",
    ownerApiKey: OWNER_KEY,
  };
});

afterAll(async () => {
  wallet?.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  await nessie.close();
  await facilitator.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterEach(() => {
  nessie.fail = [];
});

// ---------------------------------------------------------------------------

describe("bank disabled (no NESSIE_API_KEY)", () => {
  it("changes nothing: no bank fields, offline, the bank endpoints say it isn't set up", async () => {
    const before = nessie.requests.length;
    const config = { ...baseConfig, dataDir: tmp("allowance-nobank-"), nessie: { baseUrl: nessie.url, openingBalance: "5000.00" } };
    const w = createApp(config, deps());
    w.bank.start();
    const at = await listen(w);
    try {
      const { agent, token } = await createAgent("plain", {}, "20.00", at);
      expect(w.bank.enabled).toBe(false);
      const me = await call("GET", "/v1/me", { at, token });
      expect(me.body).not.toHaveProperty("bank");
      const summary = await call("GET", "/v1/summary", { at });
      expect(summary.body).not.toHaveProperty("bank");
      const topup = await call("POST", `/v1/agents/${agent.id}/topup`, { at, body: { amount: "5.00" } });
      expect(topup.status).toBe(200);
      expect(topup.body.receipt).not.toHaveProperty("bank");
      expect(events(w, "topup").at(-1)!.message).toBe("Added $5.00 to plain.");
      const paid = await paySettled(token, agent.address, "0.05", undefined, undefined, at);
      expect(paid).not.toHaveProperty("bank");
      expect(w.store.state.receipts.every((r) => r.bank === undefined)).toBe(true);

      expect((await call("GET", "/v1/bank", { at })).body).toMatchObject({ enabled: false, linked: false, provider: "Capital One", sandbox: "Nessie", accounts: [], queue: { pending: 0, failed: 0 } });
      expect((await call("GET", "/v1/bank/statement", { at })).body).toMatchObject({ error: "bank_not_enabled" });
      expect((await call("POST", "/v1/bank/link", { at })).status).toBe(409);
      expect((await call("POST", "/v1/bank/retry", { at, body: {} })).body.error).toBe("bank_not_enabled");
      expect(nessie.requests.length).toBe(before);
      expect(existsSync(join(config.dataDir, "bank.json"))).toBe(false);
    } finally {
      w.close();
    }
  });

  it("refuses a non-HTTPS Nessie base URL (plain HTTP is only for a loopback fake)", () => {
    const w = createApp({ ...baseConfig, dataDir: tmp("allowance-nobank-"), nessie: { apiKey: KEY, baseUrl: "http://api.nessieisreal.com", openingBalance: "5000.00" } }, deps());
    expect(w.bank.enabled).toBe(false);
    w.close();
  });
});

describe("Capital One bank (Nessie sandbox)", () => {
  let checkingId: string;
  const summary = async () => (await call("GET", "/v1/bank")).body as BankSummary;
  const accountBalance = async (agentId: string) => (await summary()).accounts.find((a) => a.agentId === agentId)?.balance;

  it("links at startup: owner customer and checking (opening balance in cents), kept in bank.json", async () => {
    wallet = createApp(baseConfig, deps());
    base = await listen(wallet);
    wallet.bank.start();
    await wallet.bank.drain();
    expect(nessie.writes(/^\/customers$/).map((r) => r.body)).toEqual([{ first_name: "Allowance", last_name: "Owner", address: OWNER_ADDRESS }]);
    expect(nessie.writes(/^\/customers\/[^/]+\/accounts$/).map((r) => r.body)).toEqual([{ type: "Checking", nickname: "Allowance owner checking", rewards: 0, balance: 500000 }]);
    const file = JSON.parse(readFileSync(join(baseConfig.dataDir, "bank.json"), "utf8"));
    checkingId = file.checkingId;
    const checking = nessie.accounts.get(checkingId)!;
    expect(file).toMatchObject({ units: "cents", customerId: expect.any(String), checkingLast4: String(checking.account_number).slice(-4), queue: [] });
    expect(file.created.map((c: { kind: string }) => c.kind)).toEqual(["customer", "account"]);

    const bank = await summary();
    expect(bank).toMatchObject({ enabled: true, linked: true, provider: "Capital One", sandbox: "Nessie", checking: { id: checkingId, nickname: "Allowance owner checking", last4: file.checkingLast4, balance: "5000.00" }, accounts: [], queue: { pending: 0, failed: 0 } });
    expect(bank).not.toHaveProperty("error");

    // Idempotent: linking again creates nothing.
    const writes = nessie.writes().length;
    const linked = await call("POST", "/v1/bank/link");
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ enabled: true, linked: true, checking: { id: checkingId } });
    expect((await call("POST", "/v1/bank/link")).body.checking.id).toBe(checkingId);
    expect(nessie.writes().length).toBe(writes);
    expect(nessie.unauthorized).toBe(0);
    // Owner only.
    expect((await fetch(`${base}/v1/bank`)).status).toBe(401);
  });

  it("a top-up is a checking transfer then a deposit on the agent's account, in cents, before any USDC", async () => {
    const { agent, token } = await createAgent("shopper", {}, null);
    await wallet.bank.drain();
    expect(nessie.writes(/accounts$/).at(-1)!.body).toEqual({ type: "Checking", nickname: "Allowance · shopper", rewards: 0, balance: 0 });
    const acct = accountOf(wallet, agent.id);
    expect(acct).toMatchObject({ nickname: "Allowance · shopper", last4: String(nessie.accounts.get(acct.id)!.account_number).slice(-4) });
    expect((await call("GET", "/v1/me", { token })).body.bank).toEqual({ provider: "Capital One", account: "Allowance · shopper", last4: acct.last4 });

    const from = nessie.requests.length;
    const topup = await call("POST", `/v1/agents/${agent.id}/topup`, { body: { amount: "20.00" } });
    expect(topup.status, JSON.stringify(topup.body)).toBe(200);
    const posts = nessie.requests.slice(from).filter((r) => r.method === "POST");
    expect(posts.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/accounts/${checkingId}/transfers`, body: { amount: 2000, transaction_date: TODAY, status: "completed", description: "Allowance top-up · shopper" } },
      { path: `/accounts/${acct.id}/deposits`, body: { medium: "balance", amount: 2000, transaction_date: TODAY, status: "completed", description: `Top-up from Capital One Checking ••${wallet.bank.state.checkingLast4}` } },
    ]);
    const transfer = nessie.transfers.at(-1)!;
    expect(topup.body.receipt).toMatchObject({ kind: "topup", status: "settled", amount: "20.00", bank: { status: "posted", ref: transfer.id, account: `••${acct.last4}`, postedAt: expect.any(String) } });
    expect(wallet.bank.state.links[nessie.deposits.at(-1)!._id]).toBe(transfer.id);
    expect(await balance(token)).toBe("20.00");
    const topupEvent = events(wallet, "topup").at(-1)!;
    expect(topupEvent.message).toBe(`Moved $20.00 from Capital One Checking ••${wallet.bank.state.checkingLast4} to shopper's allowance account.`);
    expect(topupEvent.receipt!.bank!.status).toBe("posted");

    // Nessie never moves `balance`; Allowance computes it from the records.
    expect(nessie.accounts.get(checkingId)!.balance).toBe(500000);
    const bank = await summary();
    expect(bank.checking!.balance).toBe("4980.00");
    expect(bank.accounts).toEqual([{ agentId: agent.id, agentName: "shopper", id: acct.id, nickname: "Allowance · shopper", last4: acct.last4, balance: "20.00" }]);
  });

  it("if the deposit half fails, the USDC is still credited and the deposit is queued", async () => {
    const { agent, token } = await createAgent("halfway", {}, null);
    await wallet.bank.drain();
    nessie.fail = [{ method: "POST", path: /deposits$/, status: 503, times: 1 }];
    const topup = await call("POST", `/v1/agents/${agent.id}/topup`, { body: { amount: "7.50" } });
    expect(topup.status, JSON.stringify(topup.body)).toBe(200);
    const transfer = nessie.transfers.at(-1)!;
    expect(topup.body.receipt.bank).toMatchObject({ status: "posted", ref: transfer.id });
    expect(await balance(token)).toBe("7.50");
    await wallet.bank.drain();
    const deposit = nessie.deposits.at(-1)!;
    expect(deposit).toMatchObject({ payee_id: accountOf(wallet, agent.id).id, amount: 750, status: "completed" });
    expect(nessie.transfers.filter((t) => t.description === "Allowance top-up · halfway")).toHaveLength(1); // the transfer is not redone
    expect(wallet.bank.state.links[deposit._id]).toBe(transfer.id);
    expect(await accountBalance(agent.id)).toBe("7.50");
    expect(receipt(wallet, topup.body.receipt.id).bank!.status).toBe("posted");
    expect(logs.some((l) => l.includes("bank: the deposit half of halfway's $7.50 top-up failed"))).toBe(true);
  });

  it("insufficient funds (on the computed checking balance): 409 and nothing is credited", async () => {
    const { agent, token } = await createAgent("broke", {}, null);
    await wallet.bank.drain();
    const checking = nessie.accounts.get(checkingId)!;
    const opening = checking.balance as number;
    const nowCents = Math.round(Number((await summary()).checking!.balance) * 100);
    checking.balance = opening - (nowCents - 1000); // computed checking is now $10.00
    const transfers = nessie.transfers.length;
    const receipts = wallet.store.state.receipts.length;
    try {
      const r = await call("POST", `/v1/agents/${agent.id}/topup`, { body: { amount: "20.00" } });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: "bank_insufficient_funds", message: "Your Capital One checking has $10.00, not enough to add $20.00." });
      expect((await call("POST", `/v1/agents/${agent.id}/topup`, { body: { amount: "10.00" } })).status).toBe(200); // exactly enough
    } finally {
      checking.balance = opening;
    }
    expect(nessie.transfers.length).toBe(transfers + 1);
    expect(wallet.store.state.receipts.length).toBe(receipts + 1);
    expect(await balance(token)).toBe("10.00");
  });

  it("bank unavailable: 502 bank_unavailable after one attempt, nothing credited (error, timeout, dropped connection)", async () => {
    const { agent, token } = await createAgent("unlucky", {}, null);
    await wallet.bank.drain();
    const receipts = wallet.store.state.receipts.length;
    const deposits = nessie.deposits.length;
    for (const status of [503, 429, "hang", "drop"] as const) {
      const attempts = nessie.writes(/transfers$/).length;
      nessie.fail = [{ method: "POST", path: /transfers$/, status }];
      const started = Date.now();
      const r = await call("POST", `/v1/agents/${agent.id}/topup`, { body: { amount: "5.00" } });
      expect(r.status, String(status)).toBe(502);
      expect(r.body).toEqual({ error: "bank_unavailable", message: "Capital One didn't confirm the transfer, so nothing was added." });
      expect(nessie.writes(/transfers$/).length - attempts, `${status}: one attempt, no retries`).toBe(1);
      expect(Date.now() - started).toBeLessThan(3000);
    }
    expect(nessie.deposits.length).toBe(deposits);
    expect(wallet.store.state.receipts.length).toBe(receipts);
    expect(await balance(token)).toBe("0.00");
    expect(logs.some((l) => l.includes("[wallet-service] bank: top-up of $5.00 for unlucky failed"))).toBe(true);
  });

  it("a settled x402 payment is queued, then posted as a purchase (cents) at the connected service; the merchant is cached", async () => {
    const { agent, token } = await createAgent("researcher");
    // Connected service, as an approval would leave it (category feeds the merchant).
    const stored = wallet.store.agentById(agent.id)!;
    stored.services.push({ id: "quantcomm", name: "Quantcomm Flood Research", provider: "Quantcomm", icon: "🌊", color: "#1D4ED8", kind: "x402", category: "data", summary: "Floods.", baseUrl: `${MERCHANT}/quantcomm`, pricing: "$0.05", maxPrice: "0.10", permissions: [], source: "directory", connectedAt: new Date().toISOString(), connectedBy: "owner" } as ConnectedService);
    await wallet.bank.drain();
    const merchantsBefore = nessie.writes(/^\/merchants$/).length;

    const paid = await paySettled(token, agent.address, "0.05", `${MERCHANT}/quantcomm/alerts`, "Quantcomm flood alerts");
    expect(paid.status).toBe("settled");
    expect(paid.bank).toEqual({ status: "queued", account: `••${accountOf(wallet, agent.id).last4}` });
    expect(events(wallet, "payment.settled").at(-1)!.receipt!.bank!.status).toBe("queued");

    await wallet.bank.drain();
    const acct = accountOf(wallet, agent.id);
    const purchase = nessie.purchases.at(-1)!;
    expect(nessie.writes(/^\/merchants$/).slice(merchantsBefore).map((r) => r.body)).toEqual([
      { name: "Quantcomm Flood Research", category: "data", address: OWNER_ADDRESS, geocode: { lat: 38.9897, lng: -76.9378 } },
    ]);
    expect(nessie.writes(/purchases$/).at(-1)).toMatchObject({ path: `/accounts/${acct.id}/purchases` });
    expect(nessie.writes(/purchases$/).at(-1)!.body).toEqual({ merchant_id: wallet.bank.state.merchants["Quantcomm Flood Research"], medium: "balance", purchase_date: TODAY, amount: 5, status: "completed", description: "Quantcomm flood alerts · paid in USDC" });
    expect(purchase.amount).toBe(5); // 5 cents, not 0.05 truncated to 0
    expect(receipt(wallet, paid.id).bank).toEqual({ status: "posted", ref: purchase._id, account: `••${acct.last4}`, postedAt: expect.any(String) });
    const posted = events(wallet, "bank.posted").at(-1)!;
    expect(posted).toMatchObject({ agentName: "researcher", message: `$0.05 at Quantcomm Flood Research posted to researcher's Capital One account ••${acct.last4}.`, receipt: { id: paid.id, bank: { status: "posted" } }, data: { receiptId: paid.id, ref: purchase._id, kind: "purchase" } });

    // Same merchant again: no second POST /merchants.
    await paySettled(token, agent.address, "0.10", `${MERCHANT}/quantcomm/companies/COF/view`, "Quantcomm analyst view");
    await wallet.bank.drain();
    expect(nessie.writes(/^\/merchants$/).length).toBe(merchantsBefore + 1);
    expect(nessie.purchases.at(-1)).toMatchObject({ merchant_id: purchase.merchant_id, amount: 10 });

    // Not under a connected service: the counterparty's name, category "online".
    await paySettled(token, agent.address, "0.05");
    await wallet.bank.drain();
    expect(nessie.writes(/^\/merchants$/).at(-1)!.body).toMatchObject({ name: "Acme Weather", category: "online" });
    expect(await accountBalance(agent.id)).toBe("19.80"); // 20.00 seed − 0.05 − 0.10 − 0.05
  });

  it("a transfer posts as a purchase at \"Transfer to 0x12…ab\"", async () => {
    const { agent, token } = await createAgent("tipper");
    const to = "0x1234567890abcdef1234567890abcdef123456ab";
    const sent = await call("POST", "/v1/transfer", { token, body: { to, amount: "1.50", memo: "tip" } });
    expect(sent.status).toBe(200);
    expect(sent.body.receipt.bank.status).toBe("queued");
    await wallet.bank.drain();
    const merchantId = wallet.bank.state.merchants["Transfer to 0x12…ab"];
    expect(nessie.merchants.get(merchantId)).toMatchObject({ name: "Transfer to 0x12…ab", category: "online" });
    expect(nessie.writes(/purchases$/).at(-1)).toMatchObject({ path: `/accounts/${accountOf(wallet, agent.id).id}/purchases`, body: { merchant_id: merchantId, amount: 150, status: "completed", description: "Transfer: tip · paid in USDC" } });
    expect(receipt(wallet, sent.body.receipt.id).bank!.status).toBe("posted");
  });

  it("an earning posts as a deposit (cents, completed)", async () => {
    const { agent, token } = await createAgent("earner", {}, null);
    const { token: payerToken } = await createAgent("bounty-payer");
    const payout = await call("POST", "/v1/transfer", { token: payerToken, body: { to: agent.address, amount: "0.50", memo: "bounty" } });
    const earn = await call("POST", "/v1/earnings", { token, body: { amount: "0.50", txHash: payout.body.receipt.txHash, description: "Bounty: API reliability check", from: { origin: MERCHANT, name: "Acme" } } });
    expect(earn.status).toBe(200);
    expect(earn.body.receipt.bank.status).toBe("queued");
    await wallet.bank.drain();
    const deposit = nessie.deposits.at(-1)!;
    expect(nessie.writes(/deposits$/).at(-1)).toEqual({
      method: "POST",
      path: `/accounts/${accountOf(wallet, agent.id).id}/deposits`,
      query: {},
      body: { medium: "balance", amount: 50, transaction_date: TODAY, status: "completed", description: "Earned · Bounty: API reliability check" },
      at: expect.any(Number),
    });
    expect(receipt(wallet, earn.body.receipt.id).bank).toMatchObject({ status: "posted", ref: deposit._id });
    expect(events(wallet, "bank.posted").at(-1)!.message).toBe(`Deposited $0.50 into earner's Capital One account ••${accountOf(wallet, agent.id).last4}.`);
    expect(await accountBalance(agent.id)).toBe("0.50");
  });

  it("blocked, denied and failed payments never reach the bank", async () => {
    const { agent, token } = await createAgent("careful", { maxPerTx: "1.00", approvalThreshold: "0.50", freezeOnViolation: false });
    await wallet.bank.drain();
    const writes = nessie.writes().length;
    const url = `${MERCHANT}/api/weather`;
    const blocked = await call("POST", "/v1/pay", { token, body: { paymentRequired: paymentRequired("5.00", url, "Acme Weather"), url } });
    expect(blocked.status).toBe(403);
    const parked = await call("POST", "/v1/pay", { token, body: { paymentRequired: paymentRequired("0.80", url, "Acme Weather"), url } });
    expect(parked.status).toBe(202);
    expect((await call("POST", `/v1/approvals/${parked.body.approvalId}/deny`, { body: { by: "dashboard" } })).status).toBe(200);
    const signed = await call("POST", "/v1/pay", { token, body: { paymentRequired: paymentRequired("0.05", url, "Acme Weather"), url } });
    const failed = await call("POST", `/v1/payments/${signed.body.paymentId}/settled`, { token, body: { settleResponse: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" } } });
    expect(failed.body.receipt.status).toBe("failed");
    await wallet.bank.drain();
    const mine = wallet.store.state.receipts.filter((r) => r.agentId === agent.id && r.kind === "spend");
    expect(mine.map((r) => r.status).sort()).toEqual(["blocked", "denied", "failed"]);
    for (const r of mine) expect(r.bank).toBeUndefined();
    expect(nessie.writes().length).toBe(writes);
  });

  it("a job that keeps failing ends failed (bank.failed); /v1/bank/retry posts it", async () => {
    const { agent, token } = await createAgent("retrier");
    await wallet.bank.drain();
    const attempts = nessie.writes(/purchases$/).length;
    nessie.fail = [{ method: "POST", path: /purchases$/, status: 500, message: "Nessie is having a moment" }];
    const paid = await paySettled(token, agent.address, "0.05");
    await wallet.bank.drain();
    expect(nessie.writes(/purchases$/).length - attempts, "1 try + 5 retries").toBe(6);
    const acct = accountOf(wallet, agent.id);
    expect(receipt(wallet, paid.id).bank).toEqual({ status: "failed", account: `••${acct.last4}`, error: expect.stringContaining("answered 500: Nessie is having a moment") });
    const failedEvent = events(wallet, "bank.failed").at(-1)!;
    expect(failedEvent).toMatchObject({ agentName: "retrier", receipt: { id: paid.id, bank: { status: "failed" } }, data: { receiptId: paid.id, kind: "purchase" } });
    expect(failedEvent.message).toMatch(/^Couldn't post retrier's \$0\.05 at Acme Weather to Capital One: Nessie POST \/accounts\/\w+\/purchases answered 500/);
    expect((await summary()).queue).toEqual({ pending: 0, failed: 1 });
    expect(logs.some((l) => /bank: retrier's \$0\.05 at Acme Weather failed \(.*\); retry 1 of 5/.test(l))).toBe(true);

    nessie.fail = [];
    const retried = await call("POST", "/v1/bank/retry", { body: { receiptId: paid.id } });
    expect(retried.body).toEqual({ queued: 1 });
    await wallet.bank.drain();
    expect(receipt(wallet, paid.id).bank).toMatchObject({ status: "posted", ref: nessie.purchases.at(-1)!._id });
    expect((await summary()).queue).toEqual({ pending: 0, failed: 0 });
    expect((await call("POST", "/v1/bank/retry", { body: {} })).body).toEqual({ queued: 0 });

    // A validation 400 (Nessie sends a bare JSON string listing the fields) is not retried.
    nessie.fail = [{ method: "POST", path: /purchases$/, status: 400, times: 1, stringBody: true, message: "[{'loc': ['body', 'payee_id'], 'msg': 'extra fields not permitted'}]" }];
    const before = nessie.writes(/purchases$/).length;
    const rejected = await paySettled(token, agent.address, "0.05");
    await wallet.bank.drain();
    expect(nessie.writes(/purchases$/).length - before).toBe(1);
    expect(receipt(wallet, rejected.id).bank).toMatchObject({ status: "failed", error: expect.stringContaining("answered 400: [{'loc': ['body', 'payee_id'], 'msg': 'extra fields not permitted'}]") });
    expect((await call("POST", "/v1/bank/retry", { body: {} })).body).toEqual({ queued: 1 });
    await wallet.bank.drain();
    expect(receipt(wallet, rejected.id).bank!.status).toBe("posted");
  });

  it("the statement: top-up deposits are transfers in, earnings deposits, purchases, newest first, receiptId matched", async () => {
    const { agent, token } = await createAgent("stmt", {}, "10.00");
    const paid = await paySettled(token, agent.address, "0.05");
    const { token: payerToken } = await createAgent("stmt-payer");
    const payout = await call("POST", "/v1/transfer", { token: payerToken, body: { to: agent.address, amount: "0.50", memo: "bounty" } });
    const earn = await call("POST", "/v1/earnings", { token, body: { amount: "0.50", txHash: payout.body.receipt.txHash, description: "Bounty", from: { origin: MERCHANT, name: "Acme" } } });
    await wallet.bank.drain();
    const seed = wallet.store.state.receipts.find((r) => r.agentId === agent.id && r.kind === "topup")!;
    expect(seed.bank).toMatchObject({ status: "posted", ref: nessie.transfers.find((t) => t.description === "Allowance top-up · stmt")!.id });
    const topupDeposit = nessie.deposits.find((d) => d.payee_id === accountOf(wallet, agent.id).id && String(d.description).startsWith("Top-up from"))!;

    const s = (await call("GET", `/v1/bank/statement?agentId=${agent.id}`)).body as BankStatementResponse;
    const acct = accountOf(wallet, agent.id);
    expect(s.account).toEqual({ id: acct.id, nickname: "Allowance · stmt", last4: acct.last4, balance: "10.45", agentId: agent.id, agentName: "stmt" });
    expect(s.entries).toEqual([
      { id: receipt(wallet, earn.body.receipt.id).bank!.ref, kind: "deposit", amount: "0.50", description: "Earned · Bounty", date: TODAY, status: "completed", receiptId: earn.body.receipt.id },
      { id: receipt(wallet, paid.id).bank!.ref, kind: "purchase", amount: "0.05", description: "Acme Weather · paid in USDC", merchant: "Acme Weather", date: TODAY, status: "completed", receiptId: paid.id },
      { id: topupDeposit._id, kind: "transfer_in", amount: "10.00", description: `Top-up from Capital One Checking ••${wallet.bank.state.checkingLast4}`, date: TODAY, status: "completed", receiptId: seed.id },
    ]);
    expect(((await call("GET", `/v1/bank/statement?agentId=${agent.id}&limit=1`)).body as BankStatementResponse).entries.map((e) => e.kind)).toEqual(["deposit"]);

    // Checking: its own transfers (listed with `id`, not `_id`), newest first.
    expect(nessie.transfers.every((t) => typeof t.id === "string" && !("_id" in t))).toBe(true);
    const checking = (await call("GET", "/v1/bank/statement")).body as BankStatementResponse;
    expect(checking.account).toMatchObject({ id: checkingId, nickname: "Allowance owner checking", last4: wallet.bank.state.checkingLast4 });
    expect(checking.account).not.toHaveProperty("agentId");
    expect(checking.entries.every((e) => e.kind === "transfer_out")).toBe(true);
    expect(checking.entries[0]).toMatchObject({ amount: "20.00", description: "Allowance top-up · stmt-payer", status: "completed" });
    expect(checking.entries[1]).toEqual({ id: seed.bank!.ref, kind: "transfer_out", amount: "10.00", description: "Allowance top-up · stmt", date: TODAY, status: "completed", receiptId: seed.id });
    expect(checking.entries.map((e) => e.id)).toEqual([...checking.entries.map((e) => e.id)].sort().reverse());

    expect((await call("GET", "/v1/bank/statement?agentId=agt_nope")).body.error).toBe("agent_not_found");
  });

  it("balances are computed from the records: withdrawals count, cancelled records don't, Nessie's status is shown", async () => {
    const { agent, token } = await createAgent("ledger");
    await wallet.bank.drain();
    const acct = accountOf(wallet, agent.id);
    expect(await accountBalance(agent.id)).toBe("20.00");
    // Someone withdraws $1.25 at Nessie directly: it shows and counts.
    const w = await fetch(`${nessie.url}/accounts/${acct.id}/withdrawals?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ medium: "balance", amount: 125, transaction_date: TODAY, status: "completed", description: "ATM" }) });
    expect(w.status).toBe(201);
    expect(await accountBalance(agent.id)).toBe("18.75");
    // A purchase Nessie later reports as cancelled no longer counts; its status string is passed through.
    const paid = await paySettled(token, agent.address, "0.05");
    await wallet.bank.drain();
    expect(await accountBalance(agent.id)).toBe("18.70");
    nessie.purchases.find((p) => p._id === receipt(wallet, paid.id).bank!.ref)!.status = "cancelled";
    expect(await accountBalance(agent.id)).toBe("18.75");
    const s = (await call("GET", `/v1/bank/statement?agentId=${agent.id}`)).body as BankStatementResponse;
    expect(s.account.balance).toBe("18.75");
    expect(s.entries.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: "purchase", amount: "0.05", status: "cancelled", receiptId: paid.id }),
      expect.objectContaining({ kind: "transfer_out", amount: "1.25", description: "ATM", status: "completed" }),
    ]);
  });

  it("/v1/summary and /v1/me carry bank", async () => {
    const { token } = await createAgent("summarized");
    await wallet.bank.drain();
    const bank = await summary();
    const s = await call("GET", "/v1/summary");
    expect(s.body.bank).toEqual({ linked: true, checkingLast4: bank.checking!.last4, checkingBalance: bank.checking!.balance });
    const me = await call("GET", "/v1/me", { token });
    expect(me.body.bank).toEqual({ provider: "Capital One", account: "Allowance · summarized", last4: expect.stringMatching(/^\d{4}$/) });
    expect(Object.keys(me.body.bank).sort()).toEqual(["account", "last4", "provider"]); // no balance
  });

  it("a reversal is a transfer on the agent's account plus a deposit back on checking", async () => {
    const { agent } = await createAgent("reverser");
    await wallet.bank.drain();
    const acct = accountOf(wallet, agent.id);
    const checkingBefore = (await summary()).checking!.balance;
    const from = nessie.requests.length;
    wallet.bank.refund({ id: agent.id, name: "reverser" }, "2.00", "t_123");
    await wallet.bank.drain();
    const posts = nessie.requests.slice(from).filter((r) => r.method === "POST");
    expect(posts.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/accounts/${acct.id}/transfers`, body: { amount: 200, transaction_date: TODAY, status: "completed", description: "Allowance top-up reversed · reverser" } },
      { path: `/accounts/${checkingId}/deposits`, body: { medium: "balance", amount: 200, transaction_date: TODAY, status: "completed", description: `Top-up reversed from reverser's allowance account ••${acct.last4}` } },
    ]);
    const bank = await summary();
    expect(bank.accounts.find((a) => a.agentId === agent.id)!.balance).toBe("18.00");
    expect(Number(bank.checking!.balance)).toBeCloseTo(Number(checkingBefore) + 2, 2);
    const checking = (await call("GET", "/v1/bank/statement")).body as BankStatementResponse;
    expect(checking.entries[0]).toMatchObject({ kind: "transfer_in", amount: "2.00", description: `Top-up reversed from reverser's allowance account ••${acct.last4}` });
    const own = (await call("GET", `/v1/bank/statement?agentId=${agent.id}`)).body as BankStatementResponse;
    expect(own.entries[0]).toMatchObject({ kind: "transfer_out", amount: "2.00", description: "Allowance top-up reversed · reverser" });
  });

  it("relinks once when the sandbox was wiped (stored ids 404), and logs it", async () => {
    const { agent, token } = await createAgent("survivor");
    await wallet.bank.drain();
    const oldChecking = checkingId;
    const customers = nessie.writes(/^\/customers$/).length;
    nessie.wipe();
    const r = await call("POST", `/v1/agents/${agent.id}/topup`, { body: { amount: "3.00" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(nessie.writes(/^\/customers$/).length).toBe(customers + 1);
    checkingId = wallet.bank.state.checkingId!;
    expect(checkingId).not.toBe(oldChecking);
    expect(nessie.accounts.get(checkingId)!.balance).toBe(500000);
    expect(r.body.receipt.bank).toMatchObject({ status: "posted", account: `••${accountOf(wallet, agent.id).last4}` });
    expect(logs.some((l) => /bank: checking ••\d{4} is gone at Nessie \(sandbox wiped\?\); relinking/.test(l))).toBe(true);
    expect(await balance(token)).toBe("23.00");
    const bank = await summary();
    expect(bank.checking!.balance).toBe("4997.00");
    expect(bank.accounts.find((a) => a.agentId === agent.id)!.balance).toBe("3.00");
  });

  it("a bank.json without \"units\": \"cents\" (a dollar-based link) relinks with a new customer", async () => {
    const dataDir = tmp("allowance-bank-legacy-");
    writeFileSync(
      join(dataDir, "bank.json"),
      JSON.stringify({ customerId: "old-customer", checkingId: "old-checking", checkingLast4: "0000", accounts: { agt_old: { id: "old-acct", nickname: "Allowance · old", last4: "1111" } }, merchants: { "Acme Weather": "old-merchant" }, created: [{ kind: "customer", id: "old-customer", at: "2026-10-17T00:00:00.000Z" }], queue: [], balances: { "old-checking": { balance: "4980.00", at: "2026-10-17T00:00:00.000Z" } } }),
    );
    const customers = nessie.writes(/^\/customers$/).length;
    const w = createApp({ ...baseConfig, dataDir }, deps());
    expect(logs.some((l) => l.includes('bank: bank.json is from a dollar-based link (no "units": "cents"); relinking with a new customer'))).toBe(true);
    expect(w.bank.linked()).toBe(false);
    w.bank.start();
    await w.bank.drain();
    expect(nessie.writes(/^\/customers$/).length).toBe(customers + 1);
    const file = JSON.parse(readFileSync(join(dataDir, "bank.json"), "utf8"));
    expect(file).toMatchObject({ units: "cents", accounts: {}, merchants: {} });
    expect(file.customerId).not.toBe("old-customer");
    expect(file.checkingId).not.toBe("old-checking");
    expect(file.balances).not.toHaveProperty("old-checking");
    expect(file.created[0]).toMatchObject({ id: "old-customer" }); // the record of what was made is kept
    expect(nessie.accounts.get(file.checkingId)!.balance).toBe(500000);
    w.close();
  });

  it("the queue survives a restart", async () => {
    const dataDir = tmp("allowance-bank-restart-");
    const slow: AppDeps = { ...deps(), bank: { ...deps().bank, retryDelaysMs: [60_000, 60_000, 60_000, 60_000, 60_000] } };
    const first = createApp({ ...baseConfig, dataDir }, slow);
    const at = await listen(first);
    first.bank.start();
    await first.bank.drain();
    const { agent, token } = await createAgent("restarter", {}, "20.00", at);
    await first.bank.drain();
    nessie.fail = [{ method: "POST", path: /purchases$/, status: 503 }];
    const paid = await paySettled(token, agent.address, "0.05", undefined, undefined, at);
    for (let i = 0; i < 200 && !first.bank.state.queue.some((j) => j.error); i++) await new Promise((r) => setTimeout(r, 10));
    first.close();
    const onDisk = JSON.parse(readFileSync(join(dataDir, "bank.json"), "utf8"));
    expect(onDisk.queue).toEqual([expect.objectContaining({ kind: "purchase", receiptId: paid.id, status: "pending", attempts: 1, nextAt: expect.any(String), error: expect.stringContaining("503") })]);

    nessie.fail = [];
    const second = createApp({ ...baseConfig, dataDir }, slow);
    second.bank.start();
    await second.bank.drain();
    expect(second.store.receiptById(paid.id)!.bank).toMatchObject({ status: "posted", ref: nessie.purchases.at(-1)!._id });
    expect(events(second, "bank.posted").at(-1)!.receipt!.id).toBe(paid.id);
    expect(JSON.parse(readFileSync(join(dataDir, "bank.json"), "utf8")).queue).toEqual([]);
    second.close();
  });

  it("spaces writes at least 150 ms apart, even when they are issued together", async () => {
    const client = new NessieClient({ apiKey: KEY, baseUrl: nessie.url });
    const from = nessie.requests.length;
    await Promise.all(["Gap A", "Gap B", "Gap C"].map((name) => client.createMerchant({ name, category: "online", address: OWNER_ADDRESS, geocode: { lat: 0, lng: 0 } })));
    const times = nessie.requests.slice(from).map((r) => r.at);
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(140);
  });

  it("the key never appears in a response, an event, a log line or a file", async () => {
    // Even when Nessie echoes a URL with the key in an error.
    const { agent, token } = await createAgent("leaky");
    await wallet.bank.drain();
    nessie.fail = [{ method: "POST", path: /purchases$/, status: 400, times: 1, stringBody: true, message: `bad request at /accounts/x/purchases?key=${KEY}` }];
    const paid = await paySettled(token, agent.address, "0.05");
    await wallet.bank.drain();
    const failed = receipt(wallet, paid.id).bank!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("key=[redacted]");
    bodies.push(JSON.stringify((await call("GET", "/v1/receipts?limit=500")).body));
    bodies.push(JSON.stringify((await call("GET", "/v1/events/recent?limit=500")).body));

    const haystacks = [
      ...bodies,
      ...logs,
      JSON.stringify(wallet.store.state.events),
      readFileSync(join(baseConfig.dataDir, "bank.json"), "utf8"),
      readFileSync(join(baseConfig.dataDir, "wallet-state.json"), "utf8"),
    ];
    expect(haystacks.length).toBeGreaterThan(50);
    for (const h of haystacks) expect(h.includes(KEY)).toBe(false);
    // ...while every request did carry it.
    expect(nessie.unauthorized).toBe(0);
    expect(logs.some((l) => l.startsWith("[wallet-service] bank:"))).toBe(true);
  });

  it("every body the wallet sent passed the fake's strict validation (which does reject extra fields)", async () => {
    expect(nessie.rejected).toEqual([]);
    // The fake really is strict: the old guess (medium + payee_id on a transfer) is a 400 with a JSON-string body.
    const r = await fetch(`${nessie.url}/accounts/${checkingId}/transfers?key=${KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ medium: "balance", payee_id: "x", amount: 1, transaction_date: TODAY, status: "completed", description: "x" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as unknown;
    expect(typeof body).toBe("string");
    expect(body).toContain("payee_id");
    expect(nessie.rejected.at(-1)!.problems).toEqual(["medium: extra fields not permitted", "payee_id: extra fields not permitted"]);
  });
});
