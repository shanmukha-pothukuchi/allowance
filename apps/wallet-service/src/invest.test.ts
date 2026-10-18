/**
 * Phase 9 in the wallet (docs/ARCHITECTURE.md §20): attestations for the brokerage, cash out to the
 * owner vault (agent and owner), earnings from a sell, and the cash-out's Capital One mirror against
 * the fake Nessie. Stub facilitator, port 0, no real Nessie key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMockSettlement } from "@allowance/wallet";
import { startStubFacilitator } from "@allowance/wallet/testing";
import type { StubFacilitator } from "@allowance/wallet/testing";
import { USDC_BASE_SEPOLIA, containsSecret, localDayKey, toBaseUnits } from "@allowance/shared";
import type { AppConfig, BankStatementResponse, BankSummary, Policy, WalletEvent } from "@allowance/shared";
import { createApp } from "./app.js";
import type { AppDeps, LookupTx, WalletApp } from "./app.js";
import { NonceCache, decodeAttestation, verifyAttestation } from "./attest.js";
import { startFakeNessie } from "./test-nessie.js";
import type { FakeNessie } from "./test-nessie.js";

const OWNER_KEY = "ok_invest_test";
const NESSIE_KEY = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const BROKERAGE = "http://localhost:4110";
const TODAY = localDayKey();

let facilitator: StubFacilitator;
let nessie: FakeNessie;
const servers: Server[] = [];
const dirs: string[] = [];
const bodies: string[] = [];
const logs: string[] = [];

const lookupTx: LookupTx = async (hash) => {
  const tx = facilitator.txs.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
  return tx ? { hash: tx.hash, from: tx.from, to: tx.to, amountBaseUnits: tx.amountBaseUnits, kind: tx.kind } : null;
};
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

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    chainMode: "mock",
    repoRoot: process.cwd(),
    dataDir: tmp("allowance-invest-"),
    facilitatorPort: 0,
    facilitatorUrl: facilitator.url,
    walletServicePort: 0,
    walletServiceUrl: "",
    merchantPort: 4021,
    merchantUrl: "http://localhost:4021",
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
    nessie: { baseUrl: "https://api.nessieisreal.com", openingBalance: "5000.00" },
    quantcommBridgePort: 0,
    quantcommBridgeUrl: "http://127.0.0.1:1",
    quantcommUrl: "http://127.0.0.1:1",
    computerUsePort: 0,
    computerUseUrl: "http://127.0.0.1:1",
    brokeragePort: 0,
    brokerageUrl: BROKERAGE,
    schedulerPort: 0,
    schedulerUrl: "http://127.0.0.1:1",
    ownerApiKey: OWNER_KEY,
    ...over,
  };
}

async function listen(w: WalletApp): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = w.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  facilitator = await startStubFacilitator();
  nessie = await startFakeNessie({ key: NESSIE_KEY });
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  await nessie.close();
  await facilitator.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterEach(() => {
  facilitator.failSettleWith = undefined;
});

function client(at: string) {
  async function call(method: string, path: string, opts: { body?: unknown; token?: string; ownerKey?: string | null } = {}) {
    const res = await fetch(`${at}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : opts.ownerKey === null ? {} : { "x-owner-key": opts.ownerKey ?? OWNER_KEY }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
  async function createAgent(name: string, initialBalance: string | null = "20.00", policy: Partial<Policy> = {}) {
    const r = await call("POST", "/v1/agents", { body: { name, policy: { allowlist: { addresses: [], origins: [] }, maxPerTx: "5.00", dailyCap: "10.00", ...policy }, ...(initialBalance ? { initialBalance } : {}) } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { agent: { id: string; name: string; address: `0x${string}` }; token: string };
  }
  return { call, createAgent };
}

const nonce = () => randomBytes(18).toString("base64url");
const events = (w: WalletApp, type?: WalletEvent["type"]) => w.store.state.events.filter((e) => !type || e.type === type);

describe("attestations (POST /v1/attest)", () => {
  let w: WalletApp;
  let api: ReturnType<typeof client>;
  beforeAll(async () => {
    w = createApp(config(), deps());
    api = client(await listen(w));
  });
  afterAll(() => w.close());

  it("signs a fixed text with the agent's key; the brokerage's check accepts it once, for its audience only", async () => {
    const { agent, token } = await api.createAgent("prover");
    const n = nonce();
    const r = await api.call("POST", "/v1/attest", { token, body: { audience: `${BROKERAGE}/brokerage/`, nonce: n } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ address: agent.address, audience: `${BROKERAGE}/brokerage`, nonce: n });
    expect(r.body.message).toBe(
      [
        "Allowance agent attestation",
        `Audience: ${BROKERAGE}/brokerage`,
        `Address: ${agent.address}`,
        `Nonce: ${n}`,
        `Issued: ${r.body.issuedAt}`,
        "This proves which wallet is asking. It authorizes no payment.",
      ].join("\n"),
    );
    expect(Date.parse(r.body.expiresAt) - Date.parse(r.body.issuedAt)).toBe(120_000);
    expect(await verifyMessage({ address: agent.address, message: r.body.message, signature: r.body.signature })).toBe(true);
    expect(decodeAttestation(r.body.header)).toEqual({ address: agent.address, audience: `${BROKERAGE}/brokerage`, nonce: n, issuedAt: r.body.issuedAt, signature: r.body.signature });

    const nonces = new NonceCache();
    expect(await verifyAttestation(r.body.header, { audiences: [`${BROKERAGE}/brokerage`], nonces })).toMatchObject({ ok: true, address: agent.address });
    expect(await verifyAttestation(r.body.header, { audiences: [`${BROKERAGE}/brokerage`], nonces })).toMatchObject({ ok: false, reason: expect.stringMatching(/already used/) });
    expect(await verifyAttestation(r.body.header, { audiences: ["http://localhost:4021/brokerage"], nonces: new NonceCache() })).toMatchObject({ ok: false });
    expect(await verifyAttestation(r.body.header, { audiences: [`${BROKERAGE}/brokerage`], nonces: new NonceCache(), now: Date.now() + 3 * 60_000 })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it("another agent's attestation names its own wallet; swapping in someone else's address breaks the signature", async () => {
    const a = await api.createAgent("prover-a");
    const b = await api.createAgent("prover-b");
    const fromB = await api.call("POST", "/v1/attest", { token: b.token, body: { audience: `${BROKERAGE}/brokerage`, nonce: nonce() } });
    expect(fromB.body.address).toBe(b.agent.address);
    const forged = Buffer.from(JSON.stringify({ ...decodeAttestation(fromB.body.header)!, address: a.agent.address })).toString("base64url");
    expect(await verifyAttestation(forged, { audiences: [`${BROKERAGE}/brokerage`], nonces: new NonceCache() })).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it("refuses bad audiences and nonces, and needs an agent token", async () => {
    const { token } = await api.createAgent("prover-c");
    for (const audience of [undefined, "", "ftp://x/brokerage", "http://x/brokerage?q=1", "http://user:pw@x/brokerage", `http://x/${"a".repeat(300)}`]) {
      expect((await api.call("POST", "/v1/attest", { token, body: { audience, nonce: nonce() } })).status, String(audience)).toBe(400);
    }
    for (const n of [undefined, "short", "has spaces in it ok", "x".repeat(129), 12345678901234567890]) {
      expect((await api.call("POST", "/v1/attest", { token, body: { audience: `${BROKERAGE}/brokerage`, nonce: n } })).status, String(n)).toBe(400);
    }
    expect((await api.call("POST", "/v1/attest", { body: { audience: `${BROKERAGE}/brokerage`, nonce: nonce() } })).status).toBe(401);
  });
});

describe("cash out (POST /v1/cashout, POST /v1/agents/:id/cashout)", () => {
  let w: WalletApp;
  let api: ReturnType<typeof client>;
  let dataDir: string;
  beforeAll(async () => {
    const c = config();
    dataDir = c.dataDir;
    w = createApp(c, deps());
    api = client(await listen(w));
  });
  afterAll(() => w.close());

  it("the agent moves USDC to the owner vault (created on first use); a cashout receipt and event; not a spend", async () => {
    const { agent, token } = await api.createAgent("saver");
    expect(existsSync(join(dataDir, "owner-vault.json"))).toBe(false);
    const r = await api.call("POST", "/v1/cashout", { token, body: { amount: "5.00" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const vaultFile = join(dataDir, "owner-vault.json");
    expect(statSync(vaultFile).mode & 0o777).toBe(0o600);
    const vault = JSON.parse(readFileSync(vaultFile, "utf8")) as { address: `0x${string}`; privateKey: string };
    expect(r.body).toMatchObject({ status: "sent", vault: vault.address, balance: "15.00" });
    expect(r.body.receipt).toMatchObject({ kind: "cashout", status: "settled", agentId: agent.id, amount: "5.00", amountBaseUnits: "5000000", description: "Cash out to owner", counterparty: { address: vault.address, name: "Owner vault" } });
    expect(r.body.receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(facilitator.txs.find((t) => t.hash === r.body.receipt.txHash)).toMatchObject({ from: agent.address, to: vault.address, amountBaseUnits: "5000000", kind: "settle" });
    expect(facilitator.balances.get(vault.address)).toBe(toBaseUnits("5.00"));
    const e = events(w, "cashout").at(-1)!;
    expect(e).toMatchObject({ agentId: agent.id, agentName: "saver", message: "saver cashed out $5.00 to you.", receipt: { id: r.body.receipt.id }, data: { by: "agent", all: false, vault: vault.address, receiptId: r.body.receipt.id, balance: "15.00" } });
    // Not a spend: the daily cap is untouched.
    const me = await api.call("GET", "/v1/me", { token });
    expect(me.body.agent).toMatchObject({ balance: "15.00", spentToday: "0.00" });
    expect(me.body.limits.remainingToday).toBe("10.00");

    const all = await api.call("POST", "/v1/cashout", { token, body: { amount: "all" } });
    expect(all.body).toMatchObject({ status: "sent", balance: "0.00", receipt: { amount: "15.00" } });
    expect(events(w, "cashout").at(-1)!.data).toMatchObject({ all: true, balance: "0.00" });
    expect(await api.call("POST", "/v1/cashout", { token, body: { amount: "all" } })).toMatchObject({ status: 400, body: { error: "nothing_to_cash_out" } });

    const v = await api.call("GET", "/v1/vault");
    expect(v.body).toEqual({ address: vault.address, source: "generated", balance: "20.00", cashedOut: "20.00", cashouts: 2 });
    expect((await api.call("GET", "/v1/vault", { token })).status).toBe(401);
    // The vault's key never leaves: not in a response, an event or a log line.
    for (const text of [...bodies, JSON.stringify(w.store.state.events), ...logs]) expect(containsSecret(text, [vault.privateKey])).toBe(false);
  });

  it("refuses amounts it can't cash out; the balance stays", async () => {
    const { token } = await api.createAgent("careful", "3.00");
    expect(await api.call("POST", "/v1/cashout", { token, body: { amount: "3.01" } })).toMatchObject({ status: 400, body: { error: "insufficient_balance", message: "careful has $3.00, not $3.01." } });
    for (const amount of [undefined, "", "abc", "-1", "0", "1.0000001", { x: 1 }]) {
      expect((await api.call("POST", "/v1/cashout", { token, body: { amount } })).body.error, JSON.stringify(amount)).toBe("invalid_request");
    }
    facilitator.failSettleWith = "insufficient_funds";
    const failed = await api.call("POST", "/v1/cashout", { token, body: { amount: "1.00" } });
    expect(failed).toMatchObject({ status: 502, body: { error: "settlement_failed", details: { receipt: { kind: "cashout", status: "failed", reason: "insufficient_funds" } } } });
    facilitator.failSettleWith = undefined;
    expect((await api.call("GET", "/v1/me", { token })).body.agent.balance).toBe("3.00");
  });

  it("a frozen agent can't cash out; the owner can, frozen or not; owner route needs the owner key", async () => {
    const { agent, token } = await api.createAgent("iceberg", "8.00");
    await api.call("POST", `/v1/agents/${agent.id}/freeze`);
    expect(await api.call("POST", "/v1/cashout", { token, body: { amount: "all" } })).toMatchObject({ status: 403, body: { error: "frozen", message: "iceberg is frozen, so only your owner can cash it out." } });
    expect((await api.call("POST", `/v1/agents/${agent.id}/cashout`, { token, body: { amount: "all" } })).status).toBe(401);
    expect((await api.call("POST", `/v1/agents/${agent.id}/cashout`, { ownerKey: "wrong", body: { amount: "all" } })).status).toBe(401);
    expect((await api.call("POST", `/v1/agents/${agent.id}/cashout`, { ownerKey: null, body: { amount: "all" } })).status).toBe(401);
    const r = await api.call("POST", `/v1/agents/${agent.id}/cashout`, { body: { amount: "2.50" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "sent", balance: "5.50", receipt: { kind: "cashout", amount: "2.50" } });
    expect(events(w, "cashout").at(-1)).toMatchObject({ message: "Cashed out $2.50 from iceberg.", data: { by: "owner" } });
    expect((await api.call("POST", `/v1/agents/${agent.id}/cashout`, { body: { amount: "all" } })).body).toMatchObject({ balance: "0.00", receipt: { amount: "5.50" } });
    expect((await api.call("POST", "/v1/agents/agt_nope/cashout", { body: { amount: "all" } })).status).toBe(404);
  });

  it("two cash-outs at once: one goes, the other is told one is in progress", async () => {
    const { token } = await api.createAgent("twice", "4.00");
    const results = await Promise.all([1, 2].map(() => api.call("POST", "/v1/cashout", { token, body: { amount: "all" } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe("cashout_in_progress");
  });

  it("chain mode needs OWNER_VAULT_ADDRESS", async () => {
    const chain = createApp(config({ chainMode: "base-sepolia" }), { ...deps(), settlement: createMockSettlement({ facilitatorUrl: facilitator.url }) });
    const c = client(await listen(chain));
    const { token } = await c.createAgent("onchain", null);
    expect(await c.call("POST", "/v1/cashout", { token, body: { amount: "all" } })).toMatchObject({ status: 501, body: { error: "vault_not_configured" } });
    chain.close();
  });
});

describe("earnings from a sell (POST /v1/earnings)", () => {
  let w: WalletApp;
  let api: ReturnType<typeof client>;
  beforeAll(async () => {
    w = createApp(config(), deps());
    api = client(await listen(w));
  });
  afterAll(() => w.close());

  it("accepts the brokerage's payout (to = the agent, the exact amount), once; the old checks still hold", async () => {
    const { agent, token } = await api.createAgent("trader", "10.00");
    const other = await api.createAgent("bystander", null);
    const brokerage = privateKeyToAccount(generatePrivateKey());
    facilitator.mint(brokerage.address, "100.00");
    // What the brokerage does on a sell: an EIP-3009 transfer settled by the facilitator.
    const payout = await createMockSettlement({ facilitatorUrl: facilitator.url }).transfer(brokerage, agent.address, toBaseUnits("12.30"), "Sold 0.1 COF");
    const report = (who: string, amount: string, txHash: string = payout.txHash) =>
      api.call("POST", "/v1/earnings", { token: who, body: { amount, txHash, description: "Sold 0.1 COF", from: { address: brokerage.address, origin: BROKERAGE, name: "Brokerage (paper)" } } });

    expect(await report(token, "12.31")).toMatchObject({ status: 400, body: { error: "tx_mismatch" } });
    expect(await report(other.token, "12.30")).toMatchObject({ status: 400, body: { error: "tx_mismatch" } });
    const ok = await report(token, "12.30");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.receipt).toMatchObject({ kind: "earn", status: "settled", amount: "12.30", description: "Sold 0.1 COF", counterparty: { address: brokerage.address, origin: BROKERAGE, name: "Brokerage (paper)" }, txHash: payout.txHash });
    expect(events(w, "earning.received").at(-1)!.message).toBe("trader earned $12.30 from Brokerage (paper).");
    expect((await api.call("GET", "/v1/me", { token })).body.agent).toMatchObject({ balance: "22.30", earnedToday: "12.30" });
    expect(await report(token, "12.30")).toMatchObject({ status: 409, body: { error: "duplicate_tx" } });

    // A cash-out is never an earning: it pays the vault. Its own receipt already holds the hash (409),
    // and for anyone else the ledger says it didn't pay them (400). A top-up's mint is refused too.
    const out = await api.call("POST", "/v1/cashout", { token, body: { amount: "1.00" } });
    expect(await report(token, "1.00", out.body.receipt.txHash)).toMatchObject({ status: 409, body: { error: "duplicate_tx" } });
    expect(await report(other.token, "1.00", out.body.receipt.txHash)).toMatchObject({ status: 400, body: { error: "tx_mismatch" } });
    const mint = facilitator.txs.find((t) => t.kind === "mint" && t.to === agent.address)!;
    expect((await report(token, "10.00", mint.hash)).status).toBe(409);
    expect(w.store.state.receipts.filter((r) => r.kind === "earn" && r.agentId === agent.id).map((r) => r.amount)).toEqual(["12.30"]);
  });
});

describe("cash out on Capital One (fake Nessie)", () => {
  let w: WalletApp;
  let api: ReturnType<typeof client>;
  let checkingId: string;
  const summary = async () => (await api.call("GET", "/v1/bank")).body as BankSummary;
  beforeAll(async () => {
    w = createApp(config({ nessie: { apiKey: NESSIE_KEY, baseUrl: nessie.url, openingBalance: "5000.00" } }), deps());
    api = client(await listen(w));
    w.bank.start();
    await w.bank.drain();
    checkingId = w.bank.state.checkingId!;
  });
  afterAll(() => w.close());

  it("a transfer on the agent's account plus a deposit on checking, in cents; checking goes up", async () => {
    const { agent, token } = await api.createAgent("cashier", "20.00");
    await w.bank.drain();
    const acct = w.bank.state.accounts[agent.id];
    const before = await summary();
    expect(before.accounts.find((a) => a.agentId === agent.id)!.balance).toBe("20.00");
    const from = nessie.requests.length;
    const r = await api.call("POST", "/v1/cashout", { token, body: { amount: "7.25" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.receipt.bank).toEqual({ status: "queued", account: `••${acct.last4}` });
    await w.bank.drain();
    const posts = nessie.requests.slice(from).filter((x) => x.method === "POST");
    expect(posts.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/accounts/${acct.id}/transfers`, body: { amount: 725, transaction_date: TODAY, status: "completed", description: "Cashed out to you · cashier" } },
      { path: `/accounts/${checkingId}/deposits`, body: { medium: "balance", amount: 725, transaction_date: TODAY, status: "completed", description: `From cashier's allowance account ••${acct.last4}` } },
    ]);
    const receipt = w.store.receiptById(r.body.receipt.id)!;
    expect(receipt.bank).toMatchObject({ status: "posted", account: `••${acct.last4}`, ref: expect.any(String) });
    expect(events(w, "bank.posted").at(-1)).toMatchObject({
      message: `Moved $7.25 from cashier's Capital One account ••${acct.last4} to Capital One Checking ••${w.bank.state.checkingLast4}.`,
      data: { kind: "cashout", receiptId: receipt.id },
    });
    const after = await summary();
    expect(after.accounts.find((a) => a.agentId === agent.id)!.balance).toBe("12.75");
    expect(Number(after.checking!.balance)).toBeCloseTo(Number(before.checking!.balance) + 7.25, 2);

    const own = (await api.call("GET", `/v1/bank/statement?agentId=${agent.id}`)).body as BankStatementResponse;
    expect(own.entries[0]).toMatchObject({ kind: "transfer_out", amount: "7.25", description: "Cashed out to you · cashier", receiptId: receipt.id });
    const checking = (await api.call("GET", "/v1/bank/statement")).body as BankStatementResponse;
    expect(checking.entries[0]).toMatchObject({ kind: "transfer_in", amount: "7.25", description: `From cashier's allowance account ••${acct.last4}`, receiptId: receipt.id });
  });

  it("an owner cash-out of a frozen agent mirrors the same way", async () => {
    const { agent } = await api.createAgent("frosty", "6.00");
    await w.bank.drain();
    await api.call("POST", `/v1/agents/${agent.id}/freeze`);
    const r = await api.call("POST", `/v1/agents/${agent.id}/cashout`, { body: { amount: "all" } });
    expect(r.status).toBe(200);
    await w.bank.drain();
    expect(w.store.receiptById(r.body.receipt.id)!.bank!.status).toBe("posted");
    expect(nessie.writes(/deposits$/).at(-1)!.body).toMatchObject({ amount: 600, description: `From frosty's allowance account ••${w.bank.state.accounts[agent.id].last4}` });
    expect((await summary()).accounts.find((a) => a.agentId === agent.id)!.balance).toBe("0.00");
  });
});
