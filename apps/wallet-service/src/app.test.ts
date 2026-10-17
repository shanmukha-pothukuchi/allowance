import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
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

const MERCHANT = "http://localhost:4021";
const PAY_TO = "0x9999999999999999999999999999999999999999";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";

let facilitator: StubFacilitator;
let wallet: WalletApp;
let server: Server;
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
    baseSepoliaRpcUrl: "http://127.0.0.1:1",
    x402FacilitatorUrl: facilitator.url,
    network: "eip155:84532",
    usdcAddress: USDC_BASE_SEPOLIA,
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
    expect(pending.body).toEqual({ status: "pending", approvalId });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);

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
    const mintRes = await fetch(`${facilitator.url}/admin/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: agent.address, amount: "0.50" }),
    });
    const payoutTx = ((await mintRes.json()) as { txHash: string }).txHash;
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
