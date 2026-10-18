import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, verifyTypedData } from "viem";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "@allowance/wallet";
import { startStubFacilitator } from "@allowance/wallet/testing";
import type { LookupTx, VerifyChallenge } from "./app.js";
import type { StubFacilitator } from "@allowance/wallet/testing";
import { USDC_BASE_SEPOLIA, containsSecret, toBaseUnits } from "@allowance/shared";
import type { AppConfig, Policy, WalletEvent, X402PaymentRequired } from "@allowance/shared";
import { createApp } from "./app.js";
import type { WalletApp } from "./app.js";
import { openStore, createAgentOffline } from "./store.js";
import { createDirectoryApp } from "../../directory/src/app.js";
import { buildCatalog } from "../../directory/src/catalog.js";

const MERCHANT = "http://localhost:4021";
const PAY_TO = "0x9999999999999999999999999999999999999999";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";

let facilitator: StubFacilitator;
let wallet: WalletApp;
let server: Server;
let directoryServer: Server;
let base: string;
let dataDir: string;
let baseConfig: AppConfig;
const logs: string[] = [];
/** Every response body we saw, for the "no private key anywhere" assertion. */
const bodies: string[] = [];

/** Overridable per test: default = the site vouches for the payment; ledger lookups go to the stub. */
let verifyChallenge: VerifyChallenge = async () => ({ ok: true });
let lookupTx: LookupTx = async (hash) => {
  const tx = facilitator.txs.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
  return tx ? { hash: tx.hash, from: tx.from, to: tx.to, amountBaseUnits: tx.amountBaseUnits } : null;
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "allowance-wallet-"));
  facilitator = await startStubFacilitator();
  // The real directory app on port 0; its catalog points at MERCHANT like the wallet's config.
  directoryServer = await new Promise((resolve) => {
    const s = createDirectoryApp({ merchantUrl: MERCHANT, directoryUrl: "http://127.0.0.1:0" }).listen(0, "127.0.0.1", () => resolve(s));
  });
  const directoryUrl = `http://127.0.0.1:${(directoryServer.address() as AddressInfo).port}`;
  const config: AppConfig = (baseConfig = {
    chainMode: "mock",
    repoRoot: process.cwd(),
    dataDir,
    facilitatorPort: 0,
    facilitatorUrl: facilitator.url,
    walletServicePort: 0,
    walletServiceUrl: "",
    merchantPort: 4021,
    merchantUrl: MERCHANT,
    dashboardPort: 4040,
    directoryPort: 0,
    directoryUrl,
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
    // No Nessie key: the bank stays off and nothing here talks to Capital One.
    nessie: { baseUrl: "https://api.nessieisreal.com", openingBalance: "5000.00" },
    quantcommBridgePort: 0,
    quantcommBridgeUrl: "http://127.0.0.1:1",
    quantcommUrl: "http://127.0.0.1:1",
    computerUsePort: 4090,
    computerUseUrl: "http://127.0.0.1:1",
    brokeragePort: 0,
    brokerageUrl: "http://127.0.0.1:1",
    schedulerPort: 0,
    schedulerUrl: "http://127.0.0.1:1",
  });
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  wallet = createApp(config, { verifyChallenge: (...a) => verifyChallenge(...a), lookupTx: (h) => lookupTx(h) });
  server = await new Promise((resolve) => {
    const s = wallet.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  wallet.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => directoryServer.close(() => r()));
  await facilitator.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterEach(() => {
  facilitator.failSettleWith = undefined;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function createAgent(name: string, policy: Partial<Policy>, initialBalance = "20.00") {
  const { status, body } = await api("POST", "/v1/agents", { name, policy, initialBalance });
  expect(status).toBe(201);
  return body as { agent: { id: string; address: `0x${string}` }; token: string; tokenId: string };
}

function paymentRequired(amountDollars: string, url = `${MERCHANT}/api/weather?city=Paris`): X402PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, description: "Acme Weather" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: USDC_BASE_SEPOLIA.toLowerCase(),
        amount: toBaseUnits(amountDollars).toString(),
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

async function recentEvents(): Promise<WalletEvent[]> {
  const { body } = await api("GET", "/v1/events/recent?limit=500");
  return body.events;
}

async function verifyHeader(header: string, from: `0x${string}`) {
  const payload = decodePaymentSignatureHeader(header);
  const { authorization, signature } = payload.payload as {
    authorization: Record<string, string>;
    signature: `0x${string}`;
  };
  expect(payload.x402Version).toBe(2);
  expect(payload.accepted.network).toBe("eip155:84532");
  expect(authorization.from).toBe(from);
  expect(authorization.to).toBe(PAY_TO);
  const ok = await verifyTypedData({
    address: from,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
    signature,
  });
  expect(ok).toBe(true);
  return payload;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("agents and tokens", () => {
  it("creates an agent with a token shown once and a key kept only on disk", async () => {
    const { agent, token, tokenId } = await createAgent("alpha", { maxPerTx: "5.00" });
    expect(token).toMatch(/^aw_[0-9a-f]{48}$/);
    expect(tokenId).toMatch(/^tok_/);
    expect(agent.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent).toMatchObject({ name: "alpha", balance: "20.00", spentToday: "0.00", frozen: false });

    const state = JSON.parse(readFileSync(join(dataDir, "wallet-state.json"), "utf8"));
    const stored = state.agents.find((a: { id: string }) => a.id === agent.id);
    expect(stored.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(state)).not.toContain(token);

    const me = await api("GET", "/v1/me", undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.agent.id).toBe(agent.id);
    expect(me.body.limits.remainingToday).toBe("25.00");

    const detail = await api("GET", `/v1/agents/${agent.id}`);
    expect(detail.body.tokens[0]).toMatchObject({ id: tokenId, hint: token.slice(-4) });
    expect(JSON.stringify(detail.body)).not.toContain(stored.privateKey);
  });

  it("rejects unknown tokens and revoked tokens with distinct codes", async () => {
    const { agent, token, tokenId } = await createAgent("beta", {});
    expect((await api("GET", "/v1/me", undefined, "aw_" + "0".repeat(48))).body).toMatchObject({ error: "unauthorized" });
    expect((await api("GET", "/v1/me")).status).toBe(401);

    const second = await api("POST", `/v1/agents/${agent.id}/tokens`);
    expect(second.status).toBe(201);
    expect((await api("DELETE", `/v1/agents/${agent.id}/tokens/${tokenId}`)).body).toEqual({ ok: true });

    const revoked = await api("GET", "/v1/me", undefined, token);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe("token_revoked");
    expect((await api("GET", "/v1/me", undefined, second.body.token)).status).toBe(200);
  });

  it("rejects duplicate names and bad policies", async () => {
    expect((await api("POST", "/v1/agents", { name: "alpha" })).status).toBe(409);
    expect((await api("POST", "/v1/agents", { name: "bad", policy: { maxPerTx: "abc" } })).status).toBe(400);
  });
});

describe("x402 payments", () => {
  it("signs an allowed payment, then records settlement", async () => {
    const { agent, token } = await createAgent("payer", { maxPerTx: "5.00", approvalThreshold: "1.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather?city=Paris` }, token);
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe("approved");
    expect(pay.body.receipt).toMatchObject({
      kind: "spend",
      status: "signed",
      amount: "0.05",
      description: "Acme Weather",
      counterparty: { address: PAY_TO, origin: MERCHANT },
    });
    await verifyHeader(pay.body.paymentHeader, agent.address);

    const events = await recentEvents();
    expect(events.find((e) => e.type === "payment.signed" && e.agentId === agent.id)?.message).toContain("$0.05");

    // Settle the signed authorization on the (stub) facilitator, as the merchant would, then report it.
    const paymentPayload = decodePaymentSignatureHeader(pay.body.paymentHeader);
    const settleRes = await fetch(`${facilitator.url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: paymentRequired("0.05").accepts[0] }),
    });
    const settleBody = (await settleRes.json()) as { success: boolean; transaction: string };
    expect(settleBody.success).toBe(true);
    const tx = settleBody.transaction;
    const settled = await api(
      "POST",
      `/v1/payments/${pay.body.paymentId}/settled`,
      { settleResponse: { success: true, transaction: tx, network: "eip155:84532", payer: agent.address } },
      token,
    );
    expect(settled.status).toBe(200);
    expect(settled.body.receipt).toMatchObject({ status: "settled", txHash: tx, explorerUrl: `${facilitator.url}/tx/${tx}` });
    expect((await recentEvents()).some((e) => e.type === "payment.settled" && e.receipt?.txHash === tx)).toBe(true);

    const me = await api("GET", "/v1/me", undefined, token);
    expect(me.body.agent.spentToday).toBe("0.05");

    const receipts = await api("GET", "/v1/receipts", undefined, token);
    expect(receipts.body.receipts).toHaveLength(2); // topup + spend
  });

  it("marks a failed settlement", async () => {
    const { token } = await createAgent("payer-fail", { approvalThreshold: "1.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.10"), url: `${MERCHANT}/api/news` }, token);
    const settled = await api(
      "POST",
      `/v1/payments/${pay.body.paymentId}/settled`,
      { settleResponse: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" } },
      token,
    );
    expect(settled.body.receipt).toMatchObject({ status: "failed", reason: "insufficient_funds" });
    // Still counted: the signed authorization is valid until validBefore, and the agent's word is not proof.
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("0.10");
  });

  it("rejects settlement reports whose tx the ledger does not know or that do not match", async () => {
    const { token } = await createAgent("payer-liar", { approvalThreshold: "1.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.10"), url: `${MERCHANT}/api/news` }, token);
    const fake = await api(
      "POST",
      `/v1/payments/${pay.body.paymentId}/settled`,
      { settleResponse: { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532" } },
      token,
    );
    expect(fake.status).toBe(400);
    expect(fake.body.error).toBe("tx_not_found");
    // A real ledger tx that belongs to someone else is not accepted either.
    const mintTx = facilitator.txs.find((t) => t.kind === "mint")!;
    const wrong = await api(
      "POST",
      `/v1/payments/${pay.body.paymentId}/settled`,
      { settleResponse: { success: true, transaction: mintTx.hash, network: "eip155:84532" } },
      token,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("tx_mismatch");
    expect((await api("GET", "/v1/receipts", undefined, token)).body.receipts.find((r: { kind: string }) => r.kind === "spend").status).toBe("signed");
  });

  it("refuses requirements that are not USDC on Base Sepolia without freezing", async () => {
    const { token } = await createAgent("payer-other", {});
    const pr = paymentRequired("0.05");
    pr.accepts[0].network = "eip155:8453";
    const pay = await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/x` }, token);
    expect(pay.status).toBe(403);
    expect(pay.body).toMatchObject({ error: "unsupported_requirements", status: "blocked", frozen: false });
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.frozen).toBe(false);
  });

  it("parks a payment over the threshold and releases it when the owner approves", async () => {
    const { agent, token } = await createAgent("pizza", { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("18.50", `${MERCHANT}/pizza/order`), url: `${MERCHANT}/pizza/order`, description: "Pizza" }, token);
    expect(pay.status).toBe(202);
    expect(pay.body).toMatchObject({ status: "needs_approval", amount: "18.50" });
    expect(pay.body.receipt.status).toBe("pending_approval");
    const approvalId: string = pay.body.approvalId;

    const pendingList = await api("GET", "/v1/approvals?status=pending");
    expect(pendingList.body.approvals.map((a: { id: string }) => a.id)).toContain(approvalId);
    expect((await recentEvents()).find((e) => e.type === "payment.needs_approval")?.approval?.id).toBe(approvalId);

    // Short wait times out as pending.
    const t0 = Date.now();
    const pending = await api("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=200`, undefined, token);
    expect(pending.body).toEqual({ kind: "payment", status: "pending", approvalId });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);

    // Tiny timeouts are honoured (not replaced by the 45 s default); 0 means "check now".
    for (const t of ["1", "0"]) {
      const t1 = Date.now();
      const quick = await api("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=${t}`, undefined, token);
      expect(quick.body, `timeoutMs=${t}`).toEqual({ kind: "payment", status: "pending", approvalId });
      expect(Date.now() - t1, `timeoutMs=${t}`).toBeLessThan(1000);
    }

    // Long wait resolves as soon as the owner approves.
    const waiting = api("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=10000`, undefined, token);
    await new Promise((r) => setTimeout(r, 50));
    const approve = await api("POST", `/v1/approvals/${approvalId}/approve`, { by: "telegram" });
    expect(approve.status).toBe(200);
    expect(approve.body.approval).toMatchObject({ status: "approved", decidedBy: "telegram" });

    const resolved = await waiting;
    expect(resolved.body.status).toBe("approved");
    expect(resolved.body.receipt.status).toBe("signed");
    await verifyHeader(resolved.body.paymentHeader, agent.address);

    // Re-waiting after the decision returns immediately with the same header.
    const again = await api("GET", `/v1/approvals/${approvalId}/wait`, undefined, token);
    expect(again.body.paymentHeader).toBe(resolved.body.paymentHeader);
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("18.50");
    expect((await recentEvents()).some((e) => e.type === "approval.approved")).toBe(true);
    expect((await api("POST", `/v1/approvals/${approvalId}/approve`, { by: "dashboard" })).status).toBe(409);
  });

  it("denies a parked payment", async () => {
    const { token } = await createAgent("denied", { maxPerTx: "20.00", approvalThreshold: "1.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("5.00"), url: `${MERCHANT}/api/stock` }, token);
    expect(pay.status).toBe(202);
    const waiting = api("GET", `/v1/approvals/${pay.body.approvalId}/wait?timeoutMs=10000`, undefined, token);
    await new Promise((r) => setTimeout(r, 30));
    const deny = await api("POST", `/v1/approvals/${pay.body.approvalId}/deny`, { by: "dashboard" });
    expect(deny.body.approval.status).toBe("denied");
    const resolved = await waiting;
    expect(resolved.body.status).toBe("denied");
    expect(resolved.body.receipt).toMatchObject({ status: "denied", reason: "denied_by_owner" });
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("0.00");
    expect((await recentEvents()).some((e) => e.type === "approval.denied")).toBe(true);
  });

  it("blocks an over-limit payment, freezes the agent, and keeps blocking while frozen", async () => {
    const { agent, token } = await createAgent("naive", { maxPerTx: "2.00", dailyCap: "10.00", approvalThreshold: "1.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("4.50"), url: `${MERCHANT}/api/weather` }, token);
    expect(pay.status).toBe(403);
    expect(pay.body).toMatchObject({ status: "blocked", reason: "max_per_tx", frozen: true });
    expect(pay.body.message).toMatch(/^Blocked: tried to send \$4\.50.*Agent frozen\.$/);
    expect(pay.body.receipt).toMatchObject({ status: "blocked", reason: "max_per_tx" });

    const events = await recentEvents();
    const blocked = events.find((e) => e.type === "payment.blocked" && e.agentId === agent.id);
    const frozen = events.find((e) => e.type === "agent.frozen" && e.agentId === agent.id);
    expect(blocked?.message).toBe(pay.body.message);
    expect(frozen?.data).toMatchObject({ cause: "policy_violation", receiptId: pay.body.receipt.id });

    const me = await api("GET", "/v1/me", undefined, token);
    expect(me.body.agent.frozen).toBe(true);
    expect(me.body.agent.frozenReason).toContain("$4.50");

    const next = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather` }, token);
    expect(next.status).toBe(403);
    expect(next.body).toMatchObject({ status: "blocked", reason: "frozen", frozen: true });
    expect(next.body.message).not.toContain("Agent frozen.");

    const unfreeze = await api("POST", `/v1/agents/${agent.id}/unfreeze`);
    expect(unfreeze.body.agent.frozen).toBe(false);
    expect((await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather` }, token)).status).toBe(200);
  });

  it("does not freeze when freezeOnViolation is off", async () => {
    const { token } = await createAgent("lenient", { maxPerTx: "1.00", freezeOnViolation: false });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("2.00"), url: `${MERCHANT}/api/weather` }, token);
    expect(pay.body).toMatchObject({ status: "blocked", reason: "max_per_tx", frozen: false });
    expect(pay.body.message).not.toContain("frozen");
  });

  it("blocks on insufficient balance without freezing", async () => {
    const { token } = await createAgent("broke", { maxPerTx: "5.00" }, "0.01");
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather` }, token);
    expect(pay.status).toBe(403);
    expect(pay.body).toMatchObject({ status: "blocked", reason: "insufficient_balance", frozen: false });
    expect(pay.body.message).toContain("$0.01");
  });

  it("enforces the daily cap across many small payments", async () => {
    const { token } = await createAgent("capped", { maxPerTx: "1.00", dailyCap: "2.50", approvalThreshold: "1.00" });
    const pr = paymentRequired("1.00");
    expect((await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/a` }, token)).status).toBe(200);
    expect((await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/a` }, token)).status).toBe(200);
    const third = await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/a` }, token);
    expect(third.status).toBe(403);
    expect(third.body).toMatchObject({ reason: "daily_cap", frozen: true });
    expect(third.body.message).toContain("$2.50");
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("2.00");
  });

  it("enforces an origin allowlist for x402 payments", async () => {
    const { token } = await createAgent("listed", { allowlist: { addresses: [], origins: [MERCHANT] }, approvalThreshold: "1.00" });
    expect((await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather` }, token)).status).toBe(200);
    const evil = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05", "http://evil.example/x"), url: "http://evil.example/x" }, token);
    expect(evil.body).toMatchObject({ status: "blocked", reason: "not_allowlisted", frozen: true });
    expect(evil.body.message).toContain("unknown site");
  });

  it("re-verifies the 402 before trusting an origin allowlist (attacker payTo under a trusted URL)", async () => {
    const { token } = await createAgent("listed-2", { allowlist: { addresses: [], origins: [MERCHANT] }, approvalThreshold: "1.00" });
    const calls: string[] = [];
    verifyChallenge = async (url, _method, req) => {
      calls.push(`${url} ${req.payTo}`);
      // The real site only asks for PAY_TO; anything else is a forged challenge.
      return req.payTo.toLowerCase() === PAY_TO.toLowerCase() ? { ok: true } : { ok: false, reason: "payTo mismatch" };
    };
    try {
      const pr = paymentRequired("0.05");
      pr.accepts[0].payTo = "0x1111111111111111111111111111111111111111";
      const forged = await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/api/news` }, token);
      expect(forged.status).toBe(403);
      expect(forged.body).toMatchObject({ status: "blocked", reason: "not_allowlisted", frozen: true });
      expect(calls).toHaveLength(1);
      // Explicitly allowlisted payTo does not need the site to vouch.
      const { token: t2 } = await createAgent("listed-3", { allowlist: { addresses: [PAY_TO], origins: [] }, approvalThreshold: "1.00" });
      const okRes = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/news` }, t2);
      expect(okRes.status).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      verifyChallenge = async () => ({ ok: true });
    }
  });
});

describe("hardening (Phase 3 verifier findings)", () => {
  it("settles a transfer approval exactly once under concurrent approve calls", async () => {
    const { agent, token } = await createAgent("double-tap", { maxPerTx: "10.00", approvalThreshold: "1.00", dailyCap: "50.00" });
    const to = "0x7777777777777777777777777777777777777777";
    const req = await api("POST", "/v1/transfer", { to, amount: "5.00" }, token);
    expect(req.status).toBe(202);
    const approvalId = req.body.approvalId as string;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api("POST", `/v1/approvals/${approvalId}/approve`, { by: "dashboard" })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    const outs = facilitator.txs.filter((t) => t.from.toLowerCase() === agent.address.toLowerCase() && t.to.toLowerCase() === to);
    expect(outs).toHaveLength(1);
    expect(facilitator.balances.get(getAddress(agent.address))).toBe(toBaseUnits("15.00"));
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("5.00");
    // deny after the fact is also refused
    expect((await api("POST", `/v1/approvals/${approvalId}/deny`, { by: "dashboard" })).status).toBe(409);
  });

  it("rejects malformed tx hashes, mints-as-earnings, and bogus challenge timeouts", async () => {
    const { agent, token } = await createAgent("strict", { approvalThreshold: "1.00" });
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather` }, token);
    expect(pay.status).toBe(200);
    for (const bad of ["%E0%A4%A", "0x1234", "not-a-hash", 42]) {
      const r = await api("POST", `/v1/payments/${pay.body.paymentId}/settled`, { settleResponse: { success: true, transaction: bad, network: "eip155:84532" } }, token);
      expect(r.status, String(bad)).toBe(400);
      const e = await api("POST", "/v1/earnings", { amount: "100.00", txHash: bad, from: { origin: MERCHANT } }, token);
      expect(e.status, String(bad)).toBe(400);
    }
    // the agent's own starting-balance mint is not an earning
    const mintTx = facilitator.txs.find((t) => t.kind === "mint" && t.to.toLowerCase() === agent.address.toLowerCase())!;
    const asEarning = await api("POST", "/v1/earnings", { amount: "20.00", txHash: mintTx.hash, from: { origin: MERCHANT } }, token);
    expect([400, 409]).toContain(asEarning.status);
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.earnedToday).toBe("0.00");
    // a 32-year authorization window is refused
    const pr = paymentRequired("0.05");
    pr.accepts[0].maxTimeoutSeconds = 1e9;
    const longLived = await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/api/weather` }, token);
    expect(longLived.status).toBe(400);
  });

  it("records one earning even when the same payout is reported concurrently", async () => {
    const { agent, token } = await createAgent("earner-race", {});
    const { token: payerToken } = await createAgent("earner-race-payer", { maxPerTx: "5.00", approvalThreshold: "5.00", allowlist: null });
    const payout = await api("POST", "/v1/transfer", { to: agent.address, amount: "0.25" }, payerToken);
    expect(payout.status).toBe(200);
    const body = { amount: "0.25", txHash: payout.body.receipt.txHash, description: "Bounty", from: { origin: MERCHANT } };
    const results = await Promise.all(Array.from({ length: 5 }, () => api("POST", "/v1/earnings", body, token)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.earnedToday).toBe("0.25");
  });

  it("refuses a string maxTimeoutSeconds (would concatenate into a never-expiring authorization)", async () => {
    const { token } = await createAgent("stringy", { approvalThreshold: "1.00" });
    const pr = paymentRequired("0.05");
    (pr.accepts[0] as { maxTimeoutSeconds: unknown }).maxTimeoutSeconds = "300";
    const r = await api("POST", "/v1/pay", { paymentRequired: pr, url: `${MERCHANT}/api/weather` }, token);
    expect(r.status).toBe(400);
  });

  it("requires X-Owner-Key on owner endpoints when a key is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-ownerkey-"));
    const w = createApp({ ...baseConfig, dataDir: dir, ownerApiKey: "ok_test" }, { store: openStore(dir), settlement: wallet.settlement });
    const srv = await new Promise<Server>((resolve) => {
      const s = w.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const open = await fetch(`${base}/v1/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "keyed-agent" }) });
      expect(open.status).toBe(401);
      const keyed = await fetch(`${base}/v1/agents`, { method: "POST", headers: { "content-type": "application/json", "x-owner-key": "ok_test" }, body: JSON.stringify({ name: "keyed-agent" }) });
      expect(keyed.status).toBe(201);
      const summary = await fetch(`${base}/v1/summary`);
      expect(summary.status).toBe(401);
      // health stays open so the dashboard can detect the service
      expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    } finally {
      w.close();
      await new Promise((r) => srv.close(() => r(null)));
    }
  });

  it("creates an agent with services connected and a safe name, and caps top-ups", async () => {
    const bad = await api("POST", "/v1/agents", { name: "Bad Name!" });
    expect(bad.status).toBe(400);
    const unknown = await api("POST", "/v1/agents", { name: "ghost-agent", services: ["no-such-service"] });
    expect(unknown.status).toBe(404);
    expect((await api("GET", "/v1/agents")).body.agents.some((a: { name: string }) => a.name === "ghost-agent")).toBe(false);
    const ok = await api("POST", "/v1/agents", { name: "travel-planner", initialBalance: "15.00", services: ["acme-weather"], policy: { allowlist: { addresses: [], origins: [] } } });
    expect(ok.status).toBe(201);
    expect(ok.body.agent.services.map((s: { id: string; connectedBy: string }) => [s.id, s.connectedBy])).toEqual([["acme-weather", "owner"]]);
    expect(ok.body.token).toMatch(/^aw_/);
    expect((await api("POST", `/v1/agents/${ok.body.agent.id}/topup`, { amount: "1000.01" })).status).toBe(400);
    expect((await api("POST", `/v1/agents/${ok.body.agent.id}/topup`, { amount: "5.00" })).status).toBe(200);
  });

  it("refuses scheme-less allowlist origins instead of storing \"null\"", async () => {
    const { agent } = await createAgent("origins", {});
    const r = await api("PATCH", `/v1/agents/${agent.id}/policy`, { allowlist: { addresses: [], origins: ["localhost:4021"] } });
    expect(r.status).toBe(400);
    const ok = await api("PATCH", `/v1/agents/${agent.id}/policy`, { allowlist: { addresses: [], origins: ["http://localhost:4021/"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.agent.policy.allowlist.origins).toEqual(["http://localhost:4021"]);
  });
});

describe("transfers", () => {
  it("settles an allowed transfer through the facilitator", async () => {
    const { agent, token } = await createAgent("sender", { maxPerTx: "5.00", approvalThreshold: "5.00" });
    const to = "0x4444444444444444444444444444444444444444";
    const res = await api("POST", "/v1/transfer", { to, amount: "1.25", memo: "thanks" }, token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.receipt).toMatchObject({ kind: "transfer", status: "settled", amount: "1.25", counterparty: { address: to } });
    expect(res.body.receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.body.receipt.explorerUrl).toContain(`${facilitator.url}/tx/`);
    expect(facilitator.balances.get(getAddress(agent.address))).toBe(toBaseUnits("18.75"));
    expect((await recentEvents()).some((e) => e.type === "transfer.sent" && e.receipt?.id === res.body.receipt.id)).toBe(true);
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("1.25");
  });

  it("holds against the poisoned-bounty attack: full balance to an unknown address", async () => {
    const { agent, token } = await createAgent("victim", {
      maxPerTx: "2.00",
      dailyCap: "10.00",
      allowlist: { addresses: [], origins: [MERCHANT] },
    });
    const res = await api("POST", "/v1/transfer", { to: ATTACKER, amount: "20.00", memo: "processing fee" }, token);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: "blocked", frozen: true });
    expect(["max_per_tx", "not_allowlisted"]).toContain(res.body.reason);
    expect(res.body.message).toContain("$20.00");
    expect(res.body.message).toContain("Agent frozen.");
    expect(facilitator.balances.get(getAddress(agent.address))).toBe(toBaseUnits("20.00"));
    expect(facilitator.balances.get(getAddress(ATTACKER)) ?? 0n).toBe(0n);

    // Even a tiny transfer to the attacker is refused by the allowlist (and the freeze).
    const small = await api("POST", "/v1/transfer", { to: ATTACKER, amount: "0.01" }, token);
    expect(small.body).toMatchObject({ status: "blocked", reason: "frozen" });
  });

  it("parks a transfer for approval and performs it on approve", async () => {
    const { agent, token } = await createAgent("big-sender", { maxPerTx: "10.00", dailyCap: "50.00", approvalThreshold: "1.00" });
    const to = "0x5555555555555555555555555555555555555555";
    const res = await api("POST", "/v1/transfer", { to, amount: "3.00" }, token);
    expect(res.status).toBe(202);
    const approve = await api("POST", `/v1/approvals/${res.body.approvalId}/approve`, { by: "telegram" });
    expect(approve.body.approval.status).toBe("approved");
    const wait = await api("GET", `/v1/approvals/${res.body.approvalId}/wait`, undefined, token);
    expect(wait.body.status).toBe("approved");
    expect(wait.body.paymentHeader).toBeUndefined();
    expect(wait.body.receipt).toMatchObject({ kind: "transfer", status: "settled" });
    expect(facilitator.balances.get(getAddress(agent.address))).toBe(toBaseUnits("17.00"));
  });

  it("reports a failed settlement as 502 with a failed receipt", async () => {
    const { token } = await createAgent("unlucky", { approvalThreshold: "5.00" });
    facilitator.failSettleWith = "nonce_already_used";
    const res = await api("POST", "/v1/transfer", { to: "0x6666666666666666666666666666666666666666", amount: "0.50" }, token);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "settlement_failed", details: { receipt: { status: "failed", reason: "nonce_already_used" } } });
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("0.00");
  });

  it("validates input", async () => {
    const { token } = await createAgent("picky", {});
    expect((await api("POST", "/v1/transfer", { to: "nope", amount: "1.00" }, token)).status).toBe(400);
    expect((await api("POST", "/v1/transfer", { to: ATTACKER, amount: "-1" }, token)).status).toBe(400);
  });
});

describe("earnings, topups, summary", () => {
  it("records earnings and top-ups", async () => {
    const { agent, token } = await createAgent("earner", {});
    // A payout is a ledger tx to the agent; the wallet checks it before believing the agent.
    // A real payout: another funded wallet settles $0.50 to the earner through the facilitator.
    const { token: payerToken } = await createAgent("bounty-payer", { maxPerTx: "5.00", approvalThreshold: "5.00", allowlist: null });
    const payout = await api("POST", "/v1/transfer", { to: agent.address, amount: "0.50", memo: "bounty" }, payerToken);
    expect(payout.status).toBe(200);
    const payoutTx = payout.body.receipt.txHash as string;
    const earnBody = { amount: "0.50", txHash: payoutTx, description: "Bounty: API reliability check", from: { origin: MERCHANT, name: "Acme" }, bountyId: "api-reliability-check" };
    const forged = await api("POST", "/v1/earnings", { ...earnBody, txHash: "0x" + "cd".repeat(32) }, token);
    expect(forged.status).toBe(400);
    expect(forged.body.error).toBe("tx_not_found");
    const inflated = await api("POST", "/v1/earnings", { ...earnBody, amount: "100.00" }, token);
    expect(inflated.status).toBe(400);
    expect(inflated.body.error).toBe("tx_mismatch");
    const earn = await api("POST", "/v1/earnings", earnBody, token);
    expect(earn.status).toBe(200);
    const dup = await api("POST", "/v1/earnings", earnBody, token);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("duplicate_tx");
    expect(earn.body.receipt).toMatchObject({ kind: "earn", status: "settled", amount: "0.50", counterparty: { origin: MERCHANT, name: "Acme" } });
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.earnedToday).toBe("0.50");

    const topup = await api("POST", `/v1/agents/${agent.id}/topup`, { amount: "5.00" });
    expect(topup.status).toBe(200);
    expect(topup.body.receipt).toMatchObject({ kind: "topup", status: "settled", amount: "5.00" });
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.balance).toBe("25.50");
    const events = await recentEvents();
    expect(events.some((e) => e.type === "earning.received" && e.agentId === agent.id)).toBe(true);
    expect(events.filter((e) => e.type === "topup" && e.agentId === agent.id)).toHaveLength(2);
  });

  it("summary, health and notifier presence", async () => {
    expect((await api("GET", "/v1/health")).body).toMatchObject({ ok: true, chainMode: "mock", telegramConnected: false });
    await api("POST", "/v1/notifier/status", { connected: true });
    const summary = await api("GET", "/v1/summary");
    expect(summary.body.telegramConnected).toBe(true);
    expect(summary.body.chainMode).toBe("mock");
    expect(summary.body.agents.length).toBeGreaterThan(5);
    expect(toBaseUnits(summary.body.totalBalance)).toBeGreaterThan(0n);
    expect(summary.body.pendingApprovals).toEqual([]);
    const owner = await api("GET", "/v1/receipts?limit=5");
    expect(owner.body.receipts).toHaveLength(5);
  });
});

describe("events", () => {
  it("delivers events over SSE", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { token } = await createAgent("sse-agent", {});
    await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather` }, token);
    let buffer = "";
    for (let i = 0; i < 20 && !buffer.includes("event: payment.signed"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    controller.abort();
    expect(buffer).toContain("event: agent.created");
    const line = buffer.split("\n").find((l) => l.startsWith("data: ") && l.includes("payment.signed"));
    expect(line).toBeDefined();
    const event = JSON.parse(line!.slice(6)) as WalletEvent;
    expect(event.agentName).toBe("sse-agent");
    expect(event.receipt?.status).toBe("signed");
  });

  it("reset clears receipts, approvals and events but keeps agents", async () => {
    const before = (await api("GET", "/v1/agents")).body.agents.length;
    expect((await api("POST", "/v1/reset")).body).toEqual({ ok: true });
    expect((await api("GET", "/v1/events/recent")).body.events).toEqual([]);
    expect((await api("GET", "/v1/receipts")).body.receipts).toEqual([]);
    expect((await api("GET", "/v1/agents")).body.agents.length).toBe(before);
  });
});

describe("offline agent creation", () => {
  it("createAgentOffline writes the state file and the server seeds it at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-offline-"));
    try {
      const store = openStore(dir);
      const { agent, token } = createAgentOffline(store, { name: "offline", policy: { maxPerTx: "1.00" }, initialBalance: "7.00" });
      expect(token).toMatch(/^aw_/);
      const state = JSON.parse(readFileSync(join(dir, "wallet-state.json"), "utf8"));
      expect(state.agents[0]).toMatchObject({ id: agent.id, seedBalance: "7.00", seedApplied: false });

      const w = createApp({ ...baseConfig, dataDir: dir }, { store: openStore(dir), settlement: wallet.settlement });
      await w.seedBalances({ retryMs: 1000 });
      expect(facilitator.balances.get(getAddress(agent.address))).toBe(toBaseUnits("7.00"));
      expect(w.store.state.agents[0].seedApplied).toBe(true);
      expect(w.store.state.receipts[0]).toMatchObject({ kind: "topup", amount: "7.00" });
      w.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeding survives a missing facilitator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-noseed-"));
    try {
      const store = openStore(dir);
      createAgentOffline(store, { name: "lonely", initialBalance: "1.00" });
      const w = createApp({ ...baseConfig, facilitatorUrl: "http://127.0.0.1:1", dataDir: dir }, { store });
      await expect(w.seedBalances({ retryMs: 300 })).resolves.toBeUndefined();
      expect(store.state.agents[0].seedApplied).toBe(false);
      w.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("connected services (§13)", () => {
  const CLOSED = { addresses: [], origins: [] };
  const shopperPolicy = { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: CLOSED };
  const PIZZA_URL = `${MERCHANT}/pizza/order`;
  const pizzaPay = () => ({ paymentRequired: paymentRequired("18.50", PIZZA_URL), url: PIZZA_URL, description: "Acme Pizza", method: "POST" as const });

  async function connect(agentId: string, serviceId: string) {
    const r = await api("POST", `/v1/agents/${agentId}/services`, { serviceId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.agent as { services: { id: string; connectedBy: string }[] };
  }

  async function withVerifyCalls<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
    const calls: string[] = [];
    verifyChallenge = async (url) => {
      calls.push(url);
      return { ok: true };
    };
    try {
      return await fn(calls);
    } finally {
      verifyChallenge = async () => ({ ok: true });
    }
  }

  it("prefix matching: connected base URL covers its paths and queries, not look-alike paths", async () => {
    const { agent, token } = await createAgent("svc-prefix", { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: CLOSED });
    await connect(agent.id, "acme-weather");
    await withVerifyCalls(async (calls) => {
      for (const url of [`${MERCHANT}/api/weather?city=Paris`, `${MERCHANT}/api/weather`, `${MERCHANT}/api/weather/hourly`, "HTTP://LOCALHOST:4021/api/weather?city=Oslo"]) {
        const r = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05", url), url }, token);
        expect(r.status, url).toBe(200);
      }
      // Allowed via a service → the wallet re-fetched the 402 every time (the URL is agent-supplied).
      expect(calls).toHaveLength(4);
    });
    const lookalike = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05", `${MERCHANT}/api/weathers`), url: `${MERCHANT}/api/weathers` }, token);
    expect(lookalike.status).toBe(403);
    expect(lookalike.body).toMatchObject({ status: "blocked", reason: "not_allowlisted", frozen: true });
  });

  it("a known but unconnected service is a soft block: 403 service_not_connected, not frozen", async () => {
    const { agent, token } = await createAgent("svc-soft", shopperPolicy);
    const pay = await api("POST", "/v1/pay", pizzaPay(), token);
    expect(pay.status).toBe(403);
    expect(pay.body).toMatchObject({ status: "blocked", reason: "service_not_connected", frozen: false });
    expect(pay.body.message).toBe("Acme Pizza is not connected for svc-soft. Ask the owner with request_service.");
    expect(pay.body.service).toEqual({ id: "acme-pizza", name: "Acme Pizza", icon: "🍕" });
    expect(pay.body.serviceId).toBe("acme-pizza");
    expect(pay.body.receipt).toMatchObject({ status: "blocked", reason: "service_not_connected" });
    const me = await api("GET", "/v1/me", undefined, token);
    expect(me.body.agent.frozen).toBe(false);
    expect(me.body.agent.services).toEqual([]);
    const events = await recentEvents();
    expect(events.find((e) => e.type === "payment.blocked" && e.agentId === agent.id)?.data).toMatchObject({ frozen: false, willFreeze: false });
    expect(events.some((e) => e.type === "agent.frozen" && e.agentId === agent.id)).toBe(false);
  });

  it("an unknown destination stays not_allowlisted and freezes", async () => {
    const { token } = await createAgent("svc-unknown", shopperPolicy);
    const url = "http://evil.example/pizza/order";
    const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("4.50", url), url }, token);
    expect(pay.body).toMatchObject({ status: "blocked", reason: "not_allowlisted", frozen: true });
    expect(pay.body.message).toMatch(/Agent frozen\.$/);
    expect(pay.body).not.toHaveProperty("service");
    expect(pay.body).not.toHaveProperty("serviceId");
    const transfer = await api("POST", "/v1/transfer", { to: ATTACKER, amount: "1.00" }, token);
    expect(transfer.body).toMatchObject({ status: "blocked", reason: "frozen" });
  });

  it("request → owner approves → /wait returns the service → the payment is now allowed", async () => {
    const { agent, token } = await createAgent("svc-shopper", shopperPolicy);
    const reqBody = { serviceId: "acme-pizza", reason: "The owner asked me to order lunch." };
    const req = await api("POST", "/v1/services/requests", reqBody, token);
    expect(req.status).toBe(202);
    expect(req.body).toMatchObject({ status: "needs_approval", service: { id: "acme-pizza", name: "Acme Pizza", maxPrice: "18.50", source: "directory" } });
    expect(req.body.service).not.toHaveProperty("docs");
    const approvalId: string = req.body.approvalId;

    // Asking again while pending returns the same approval (one card for the owner).
    expect((await api("POST", "/v1/services/requests", reqBody, token)).body.approvalId).toBe(approvalId);

    const pending = (await api("GET", "/v1/approvals?status=pending")).body.approvals.find((a: { id: string }) => a.id === approvalId);
    expect(pending).toMatchObject({ kind: "service", paymentId: "", amount: "18.50", reason: reqBody.reason, description: "Connect Acme Pizza", service: { id: "acme-pizza" } });
    expect((await api("GET", "/v1/summary")).body.pendingApprovals.map((a: { id: string }) => a.id)).toContain(approvalId);
    const requested = (await recentEvents()).find((e) => e.type === "service.requested" && e.approval?.id === approvalId);
    expect(requested?.message).toBe("svc-shopper wants to connect Acme Pizza.");
    expect(requested?.data).toMatchObject({ custom: false });

    expect((await api("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=1`, undefined, token)).body).toEqual({
      kind: "service",
      status: "pending",
      approvalId,
      service: req.body.service,
    });
    const waiting = api("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=10000`, undefined, token);
    await new Promise((r) => setTimeout(r, 50));
    const approve = await api("POST", `/v1/approvals/${approvalId}/approve`, { by: "telegram" });
    expect(approve.status).toBe(200);
    expect(approve.body.approval).toMatchObject({ status: "approved", decidedBy: "telegram", kind: "service" });

    const resolved = await waiting;
    expect(resolved.body).toMatchObject({ kind: "service", status: "approved", approvalId, service: { id: "acme-pizza", connectedBy: "approval" } });
    expect(resolved.body.paymentHeader).toBeUndefined();
    expect(resolved.body.receipt).toBeUndefined();

    const events = await recentEvents();
    expect(events.some((e) => e.type === "approval.approved" && e.approval?.id === approvalId)).toBe(true);
    const connected = events.find((e) => e.type === "service.connected" && e.agentId === agent.id);
    expect(connected?.message).toBe("Acme Pizza connected to svc-shopper.");
    expect(connected?.data).toMatchObject({ connectedBy: "approval", service: { id: "acme-pizza" } });

    const services = await api("GET", "/v1/services", undefined, token);
    expect(services.body.connected.map((s: { id: string }) => s.id)).toEqual(["acme-pizza"]);
    expect(services.body.directoryUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.services[0]).toMatchObject({ id: "acme-pizza", connectedBy: "approval" });
    expect((await api("GET", "/v1/summary")).body.agents.find((a: { id: string }) => a.id === agent.id).services).toHaveLength(1);
    // Now connected: asking again is a no-op.
    expect(await api("POST", "/v1/services/requests", reqBody, token)).toMatchObject({ status: 200, body: { status: "connected", service: { id: "acme-pizza" } } });

    // The pizza now goes through: over the $10 threshold, so it is parked for approval as usual.
    await withVerifyCalls(async (calls) => {
      const pay = await api("POST", "/v1/pay", pizzaPay(), token);
      expect(pay.status).toBe(202);
      expect(calls).toEqual([PIZZA_URL]);
      const ok = await api("POST", `/v1/approvals/${pay.body.approvalId}/approve`, { by: "dashboard" });
      expect(ok.body.approval.status).toBe("approved");
      const w = await api("GET", `/v1/approvals/${pay.body.approvalId}/wait`, undefined, token);
      expect(w.body).toMatchObject({ status: "approved", request: { url: PIZZA_URL, method: "POST" }, receipt: { status: "signed" } });
      await verifyHeader(w.body.paymentHeader, agent.address);
    });
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.spentToday).toBe("18.50");
  });

  it("a forged challenge under a connected service is still not_allowlisted + frozen", async () => {
    const { agent, token } = await createAgent("svc-forged", shopperPolicy);
    await connect(agent.id, "acme-pizza");
    verifyChallenge = async () => ({ ok: false, reason: "payTo mismatch" });
    try {
      const pr = paymentRequired("18.50", PIZZA_URL);
      pr.accepts[0].payTo = ATTACKER;
      const pay = await api("POST", "/v1/pay", { paymentRequired: pr, url: PIZZA_URL, method: "POST" }, token);
      expect(pay.body).toMatchObject({ status: "blocked", reason: "not_allowlisted", frozen: true });
    } finally {
      verifyChallenge = async () => ({ ok: true });
    }
  });

  it("a site that stopped asking for payment is refused without a freeze or a receipt", async () => {
    const { agent, token } = await createAgent("svc-gone", shopperPolicy);
    await connect(agent.id, "acme-pizza");
    verifyChallenge = async () => ({ ok: false, reason: "answered 410, not 402", unconfirmed: true });
    try {
      const pay = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("18.50", PIZZA_URL), url: PIZZA_URL, method: "POST" }, token);
      expect(pay.status).toBe(403);
      expect(pay.body).toMatchObject({ error: "payment_not_confirmed", status: "blocked", frozen: false });
      const me = (await api("GET", "/v1/me", undefined, token)).body;
      expect(me.agent.frozen).toBe(false);
      expect(me.agent.spentToday).toBe("0.00");
      expect((await api("GET", "/v1/receipts", undefined, token)).body.receipts.filter((r: { kind: string }) => r.kind === "spend")).toEqual([]);
    } finally {
      verifyChallenge = async () => ({ ok: true });
    }
  });

  it("owner denies a service request", async () => {
    const { agent, token } = await createAgent("svc-denied", shopperPolicy);
    const req = await api("POST", "/v1/services/requests", { serviceId: "acme-pizza" }, token);
    const waiting = api("GET", `/v1/approvals/${req.body.approvalId}/wait?timeoutMs=10000`, undefined, token);
    await new Promise((r) => setTimeout(r, 30));
    const deny = await api("POST", `/v1/approvals/${req.body.approvalId}/deny`, { by: "dashboard" });
    expect(deny.body.approval).toMatchObject({ status: "denied", kind: "service" });
    expect((await waiting).body).toEqual({ kind: "service", status: "denied", approvalId: req.body.approvalId, reason: "denied_by_owner", service: req.body.service });
    expect((await api("GET", "/v1/services", undefined, token)).body.connected).toEqual([]);
    const denied = (await recentEvents()).find((e) => e.type === "approval.denied" && e.approval?.id === req.body.approvalId);
    expect(denied?.message).toBe("Denied by dashboard: Acme Pizza will not be connected to svc-denied.");
    expect((await recentEvents()).some((e) => e.type === "service.connected" && e.agentId === agent.id)).toBe(false);
    expect((await api("POST", "/v1/pay", pizzaPay(), token)).body.reason).toBe("service_not_connected");
    expect((await api("POST", `/v1/approvals/${req.body.approvalId}/approve`, {})).status).toBe(409);
  });

  it("service approvals expire like payments", async () => {
    const { token } = await createAgent("svc-expired", shopperPolicy);
    const req = await api("POST", "/v1/services/requests", { serviceId: "acme-news" }, token);
    const approval = wallet.store.approvalById(req.body.approvalId)!;
    approval.createdAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect((await api("GET", "/v1/approvals?status=pending")).body.approvals.some((a: { id: string }) => a.id === approval.id)).toBe(false);
    expect((await api("GET", `/v1/approvals/${approval.id}/wait`, undefined, token)).body).toEqual({ kind: "service", status: "expired", approvalId: approval.id, service: req.body.service });
    const ev = (await recentEvents()).find((e) => e.type === "approval.denied" && e.approval?.id === approval.id);
    expect(ev).toMatchObject({ reason: "expired", message: "Request to connect Acme News for svc-expired expired." });
  });

  it("owner connects and disconnects directly", async () => {
    const { agent, token } = await createAgent("svc-owner", { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: CLOSED });
    const after = await connect(agent.id, "acme-weather");
    expect(after.services).toEqual([expect.objectContaining({ id: "acme-weather", connectedBy: "owner", maxPrice: "0.05", baseUrl: `${MERCHANT}/api/weather` })]);
    expect((await connect(agent.id, "acme-weather")).services).toHaveLength(1); // idempotent
    expect((await connect(agent.id, "directory")).services).toHaveLength(1); // always available, never stored
    const ev = (await recentEvents()).filter((e) => e.type === "service.connected" && e.agentId === agent.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ connectedBy: "owner" });

    const listing = await api("GET", "/v1/directory?q=weather");
    expect(listing.body.services).toHaveLength(1);
    expect(listing.body.services[0].connectedAgents).toContain(agent.id);
    expect(listing.body.services[0]).not.toHaveProperty("connected");
    expect(listing.body.services[0]).not.toHaveProperty("docs");
    expect((await api("GET", "/v1/directory/acme-weather")).body).toMatchObject({ id: "acme-weather", connectedAgents: expect.arrayContaining([agent.id]) });

    const ok = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather?city=Paris` }, token);
    expect(ok.status).toBe(200);

    const del = await api("DELETE", `/v1/agents/${agent.id}/services/acme-weather`);
    expect(del.status).toBe(200);
    expect(del.body.agent.services).toEqual([]);
    expect((await api("DELETE", `/v1/agents/${agent.id}/services/acme-weather`)).status).toBe(200);
    const gone = (await recentEvents()).filter((e) => e.type === "service.disconnected" && e.agentId === agent.id);
    expect(gone).toHaveLength(1);
    expect(gone[0].message).toBe("Acme Weather disconnected from svc-owner.");
    const blocked = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather?city=Paris` }, token);
    expect(blocked.body).toMatchObject({ reason: "service_not_connected", frozen: false });

    expect((await api("POST", `/v1/agents/${agent.id}/services`, { serviceId: "acme-spaceship" })).body.error).toBe("service_not_found");
    expect((await api("POST", `/v1/agents/${agent.id}/services`, {})).status).toBe(400);
    expect((await api("POST", `/v1/agents/agt_nope/services`, { serviceId: "acme-news" })).status).toBe(404);
  });

  it("agent view of the directory marks connected services and serves docs", async () => {
    const { agent, token } = await createAgent("svc-browse", shopperPolicy);
    await connect(agent.id, "acme-news");
    const all = await api("GET", "/v1/directory", undefined, token);
    // The whole catalog (it grows as services join the directory, e.g. Quantcomm in §17.2).
    const catalogIds = buildCatalog({ merchantUrl: MERCHANT, directoryUrl: "http://127.0.0.1:1" }).map((s) => s.id);
    expect(all.body.services).toHaveLength(catalogIds.length);
    const byId = Object.fromEntries(all.body.services.map((s: { id: string; connected: boolean }) => [s.id, s.connected]));
    expect(byId).toEqual(Object.fromEntries(catalogIds.map((id) => [id, id === "directory" || id === "acme-news"])));
    expect(byId).toMatchObject({ directory: true, "acme-weather": false, "acme-news": true, "acme-stocks": false, "acme-pizza": false, "acme-bounties": false });
    expect(all.body.services[0]).not.toHaveProperty("connectedAgents");
    const pizza = await api("GET", "/v1/directory/acme-pizza", undefined, token);
    expect(pizza.body).toMatchObject({ id: "acme-pizza", connected: false });
    expect(pizza.body.docs).toContain("/pizza/order");
    expect((await api("GET", "/v1/directory?q=pizza", undefined, token)).body.services.map((s: { id: string }) => s.id)).toEqual(["acme-pizza"]);
    expect((await api("GET", "/v1/directory/acme-spaceship", undefined, token)).status).toBe(404);
    expect((await api("POST", "/v1/services/requests", { serviceId: "acme-spaceship" }, token)).body.error).toBe("service_not_found");
    expect((await api("POST", "/v1/services/requests", { serviceId: "directory" }, token)).body).toMatchObject({ status: "connected", service: { id: "directory" } });
    expect((await api("GET", "/v1/services")).status).toBe(401);
  });

  it("agent tokens cannot call owner service endpoints", async () => {
    const { agent, token } = await createAgent("svc-sneaky", shopperPolicy);
    // Keyless dev app: a Bearer token is still refused on owner routes.
    expect((await api("POST", `/v1/agents/${agent.id}/services`, { serviceId: "acme-pizza" }, token)).status).toBe(401);
    expect((await api("DELETE", `/v1/agents/${agent.id}/services/acme-pizza`, undefined, token)).status).toBe(401);
    // Keyed app (production): owner key required.
    const dir = mkdtempSync(join(tmpdir(), "allowance-svc-owner-"));
    const w = createApp({ ...baseConfig, dataDir: dir, ownerApiKey: "ok_test" }, { store: openStore(dir), settlement: wallet.settlement });
    const srv = await new Promise<Server>((resolve) => {
      const s = w.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      fetch(`${b}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const created = await (await call("POST", "/v1/agents", { "x-owner-key": "ok_test" }, { name: "sneaky", policy: shopperPolicy })).json();
      const bearer = { authorization: `Bearer ${created.token}` };
      expect((await call("POST", `/v1/agents/${created.agent.id}/services`, bearer, { serviceId: "acme-pizza" })).status).toBe(401);
      expect((await call("DELETE", `/v1/agents/${created.agent.id}/services/acme-pizza`, bearer)).status).toBe(401);
      expect((await call("POST", `/v1/approvals/apr_x/approve`, bearer, {})).status).toBe(401);
      expect((await call("GET", "/v1/directory", {})).status).toBe(401);
      expect((await call("GET", "/v1/directory", bearer)).status).toBe(200);
      const req = await (await call("POST", "/v1/services/requests", bearer, { serviceId: "acme-pizza" })).json();
      expect((await call("POST", `/v1/approvals/${req.approvalId}/approve`, bearer, {})).status).toBe(401);
      expect((await call("POST", `/v1/agents/${created.agent.id}/services`, { "x-owner-key": "ok_test" }, { serviceId: "acme-pizza" })).status).toBe(200);
    } finally {
      w.close();
      await new Promise((r) => srv.close(() => r(null)));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("another agent cannot wait on or see a service approval", async () => {
    const { token } = await createAgent("svc-a", shopperPolicy);
    const { token: other } = await createAgent("svc-b", shopperPolicy);
    const req = await api("POST", "/v1/services/requests", { serviceId: "acme-stocks" }, token);
    expect((await api("GET", `/v1/approvals/${req.body.approvalId}/wait?timeoutMs=10`, undefined, other)).status).toBe(404);
  });

  it("validates custom proposals", async () => {
    const { token } = await createAgent("svc-custom-bad", { ...shopperPolicy, maxPerTx: "1.00" });
    const good = { name: "Example API", baseUrl: "https://api.example.com/v1/", summary: "Example data", maxPrice: "0.50" };
    const bad: unknown[] = [
      {},
      { serviceId: "acme-pizza", custom: good },
      { custom: "nope" },
      { custom: { ...good, name: "" } },
      { custom: { ...good, name: "x".repeat(61) } },
      { custom: { ...good, summary: "" } },
      { custom: { ...good, summary: "s".repeat(201) } },
      { custom: { ...good, baseUrl: "ftp://api.example.com" } },
      { custom: { ...good, baseUrl: "javascript:alert(1)" } },
      { custom: { ...good, baseUrl: "api.example.com" } },
      { custom: { ...good, baseUrl: "https://user:pw@api.example.com" } },
      { custom: { ...good, baseUrl: "https://api.example.com/v1?key=1" } },
      { custom: { ...good, maxPrice: "1.01" } },
      { custom: { ...good, maxPrice: "-1" } },
      { custom: { ...good, maxPrice: 0.5 } },
      { custom: { ...good, docs: 42 } },
      { serviceId: "Acme Pizza!" },
      { serviceId: "acme-pizza", reason: 7 },
    ];
    for (const body of bad) {
      const r = await api("POST", "/v1/services/requests", body, token);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe("invalid_request");
    }
    expect((await api("POST", "/v1/services/requests", { custom: { ...good, name: "x".repeat(60), maxPrice: "1.00" } }, token)).status).toBe(202);
  });

  it("custom proposal: flagged source agent, approved with its docs, then payable up to its cap", async () => {
    const { agent, token } = await createAgent("svc-custom", { ...shopperPolicy, maxPerTx: "1.00", approvalThreshold: "1.00" });
    const custom = { name: "Example API", baseUrl: "https://API.example.com/v1/", summary: "Example data feed", maxPrice: "0.50", docs: "GET https://api.example.com/v1/quote" };
    const req = await api("POST", "/v1/services/requests", { custom, reason: "I need example data" }, token);
    expect(req.status).toBe(202);
    expect(req.body.service).toMatchObject({
      id: "custom-example-api",
      name: "Example API",
      provider: "Proposed by svc-custom",
      kind: "x402",
      baseUrl: "https://api.example.com/v1",
      maxPrice: "0.50",
      source: "agent",
      permissions: ["Pay up to $0.50 per payment to Example API (api.example.com)"],
    });
    const requested = (await recentEvents()).find((e) => e.type === "service.requested" && e.approval?.id === req.body.approvalId);
    expect(requested?.approval).toMatchObject({ kind: "service", amount: "0.50", description: "Connect Example API (proposed by svc-custom)", service: { source: "agent" } });
    expect(requested?.data).toMatchObject({ custom: true });

    expect((await api("POST", `/v1/approvals/${req.body.approvalId}/approve`, { by: "dashboard" })).status).toBe(200);
    const services = (await api("GET", "/v1/services", undefined, token)).body.connected;
    expect(services).toEqual([expect.objectContaining({ id: "custom-example-api", source: "agent", connectedBy: "approval", docs: custom.docs })]);
    const manifest = await api("GET", "/v1/directory/custom-example-api", undefined, token);
    expect(manifest.body).toMatchObject({ id: "custom-example-api", docs: custom.docs, connected: true, source: "agent" });
    expect((await api("GET", "/v1/directory/custom-example-api")).body.connectedAgents).toEqual([agent.id]);
    // Proposing the same thing again is a no-op.
    expect((await api("POST", "/v1/services/requests", { custom }, token)).body.status).toBe("connected");

    const url = "https://api.example.com/v1/quote?x=1";
    await withVerifyCalls(async (calls) => {
      expect((await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.50", url), url }, token)).status).toBe(200);
      expect(calls).toEqual([url]);
    });
    const over = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.51", url), url }, token);
    expect(over.body).toMatchObject({ status: "blocked", reason: "service_cap", frozen: false });
  });

  it("service_cap: a connected service cannot charge more than its maxPrice (no freeze)", async () => {
    const { agent, token } = await createAgent("svc-cap", { maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "5.00", allowlist: CLOSED });
    await connect(agent.id, "acme-weather");
    const r = await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.06"), url: `${MERCHANT}/api/weather?city=Paris` }, token);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ status: "blocked", reason: "service_cap", frozen: false });
    expect(r.body.message).toBe("Blocked: tried to send $0.06 to Acme Weather, over its $0.05 per-payment cap.");
    expect((await api("GET", "/v1/me", undefined, token)).body.agent.frozen).toBe(false);
    expect((await api("POST", "/v1/pay", { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather?city=Paris` }, token)).status).toBe(200);
  });

  it("five concurrent approves of one service approval: exactly one 200, one connection", async () => {
    const { agent, token } = await createAgent("svc-race", shopperPolicy);
    const req = await api("POST", "/v1/services/requests", { serviceId: "acme-pizza" }, token);
    const results = await Promise.all(Array.from({ length: 5 }, () => api("POST", `/v1/approvals/${req.body.approvalId}/approve`, { by: "dashboard" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(wallet.store.agentById(agent.id)!.services.filter((s) => s.id === "acme-pizza")).toHaveLength(1);
    const events = await recentEvents();
    expect(events.filter((e) => e.type === "service.connected" && e.agentId === agent.id)).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval.approved" && e.approval?.id === req.body.approvalId)).toHaveLength(1);
    expect((await api("POST", `/v1/approvals/${req.body.approvalId}/deny`, {})).status).toBe(409);
  });

  it("directory down: 503 directory_unavailable, and payments never fail open (blocked, not frozen)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-nodir-"));
    const store = openStore(dir);
    const weather = buildCatalog({ merchantUrl: MERCHANT, directoryUrl: "http://127.0.0.1:1" }).find((s) => s.id === "acme-weather")!;
    const { docs: _docs, ...grant } = weather;
    const withWeather = createAgentOffline(store, {
      name: "nodir-researcher",
      policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: CLOSED },
      services: [{ ...grant, connectedAt: new Date().toISOString(), connectedBy: "default" }],
    });
    const plain = createAgentOffline(store, { name: "nodir-shopper", policy: shopperPolicy });
    for (const a of [withWeather, plain]) {
      await fetch(`${facilitator.url}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: a.agent.address, amount: "20.00" }) });
    }
    const w = createApp({ ...baseConfig, dataDir: dir, directoryUrl: "http://127.0.0.1:1" }, { store, settlement: wallet.settlement, verifyChallenge: async () => ({ ok: true }), lookupTx: (h) => lookupTx(h) });
    const srv = await new Promise<Server>((resolve) => {
      const s = w.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const r = await fetch(`${b}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      bodies.push(text);
      return { status: r.status, body: JSON.parse(text) };
    };
    try {
      for (const [method, path, body] of [
        ["GET", "/v1/directory", undefined],
        ["GET", "/v1/directory/acme-pizza", undefined],
        ["POST", "/v1/services/requests", { serviceId: "acme-pizza" }],
      ] as const) {
        const r = await call(method, path, plain.token, body);
        expect(r.status, path).toBe(503);
        expect(r.body.error).toBe("directory_unavailable");
      }
      expect((await call("POST", `/v1/agents/${plain.agent.id}/services`, undefined, { serviceId: "acme-pizza" })).status).toBe(503);
      // Custom proposals do not need the directory.
      expect((await call("POST", "/v1/services/requests", plain.token, { custom: { name: "X", baseUrl: "https://x.example", summary: "x", maxPrice: "0.10" } })).status).toBe(202);

      // Unknown-or-unconnected URL with the directory down: still blocked (never allowed), but no freeze.
      const pay = await call("POST", "/v1/pay", plain.token, pizzaPay());
      expect(pay.status).toBe(403);
      expect(pay.body).toMatchObject({ status: "blocked", reason: "not_allowlisted", frozen: false });
      expect((await call("GET", "/v1/me", plain.token)).body.agent.frozen).toBe(false);
      expect(logs.some((l) => l.includes("directory unavailable") && l.includes("without freezing"))).toBe(true);
      // Direct transfers to unknown addresses never depend on the directory: block + freeze.
      expect((await call("POST", "/v1/transfer", plain.token, { to: ATTACKER, amount: "1.00" })).body).toMatchObject({ reason: "not_allowlisted", frozen: true });

      // Connected services keep working without the directory.
      const ok = await call("POST", "/v1/pay", withWeather.token, { paymentRequired: paymentRequired("0.05"), url: `${MERCHANT}/api/weather?city=Paris` });
      expect(ok.status).toBe(200);
      expect((await call("GET", "/v1/services", withWeather.token)).body.connected.map((s: { id: string }) => s.id)).toEqual(["acme-weather"]);
    } finally {
      w.close();
      await new Promise((r) => srv.close(() => r(null)));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates old state (agents without services) and createAgentOffline stores services", () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-migrate-"));
    try {
      const store = openStore(dir);
      createAgentOffline(store, { name: "old" });
      const raw = JSON.parse(readFileSync(join(dir, "wallet-state.json"), "utf8"));
      delete raw.agents[0].services;
      delete raw.serviceRequests;
      writeFileSync(join(dir, "wallet-state.json"), JSON.stringify(raw));
      const reopened = openStore(dir);
      expect(reopened.state.agents[0].services).toEqual([]);
      expect(reopened.state.serviceRequests).toEqual({});
      const weather = buildCatalog({ merchantUrl: MERCHANT, directoryUrl: "http://d" })[1];
      const { agent } = createAgentOffline(reopened, {
        name: "new",
        services: [
          { ...weather, connectedAt: "2026-01-01T00:00:00.000Z", connectedBy: "default" },
          { ...weather, connectedAt: "2026-01-01T00:00:00.000Z", connectedBy: "default" },
        ],
      });
      expect(agent.services.map((s) => s.id)).toEqual(["acme-weather"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secrecy", () => {
  it("no private key ever appears in a response, an event, or the console", async () => {
    const state = JSON.parse(readFileSync(join(dataDir, "wallet-state.json"), "utf8"));
    const keys: string[] = state.agents.map((a: { privateKey: string }) => a.privateKey);
    expect(keys.length).toBeGreaterThan(5);
    const haystacks = [...bodies, ...logs, JSON.stringify(wallet.store.state.events)];
    for (const h of haystacks) expect(containsSecret(h, keys)).toBe(false);
    // Sanity: the detector works.
    expect(containsSecret(`x ${keys[0]} y`, keys)).toBe(true);
    expect(logs.some((l) => l.startsWith("[wallet-service]"))).toBe(true);
  });
});
