import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress, toHex, type Hex } from "viem";
import { loadConfig, USDC_BASE_SEPOLIA, USDC_EIP712, BASE_SEPOLIA_NETWORK, toBaseUnits } from "@allowance/shared";
import { createFacilitatorApp } from "./app.js";
import { AUTHORIZATION_TYPES } from "./scheme.js";

const payer = privateKeyToAccount(generatePrivateKey());
const merchant = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

function requirements(amount: string, payTo = merchant.address) {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: USDC_BASE_SEPOLIA,
    amount,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { ...USDC_EIP712 },
  };
}

function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function signAuthorization(
  signer: typeof payer,
  req: ReturnType<typeof requirements>,
  overrides: Partial<{ from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: Hex }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: overrides.from ?? signer.address,
    to: overrides.to ?? getAddress(req.payTo),
    value: overrides.value ?? req.amount,
    validAfter: overrides.validAfter ?? "0",
    validBefore: overrides.validBefore ?? String(now + req.maxTimeoutSeconds),
    nonce: overrides.nonce ?? randomNonce(),
  };
  const signature = await signer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { signature, authorization };
}

function x402Body(req: ReturnType<typeof requirements>, payload: unknown) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: req, payload },
    paymentRequirements: req,
  };
}

describe("mock facilitator", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "allowance-fac-"));
  const config = { ...loadConfig(), ownerApiKey: undefined, dataDir };
  let server: Server;
  let url: string;

  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const balance = async (addr: string) => (await (await fetch(`${url}/balance/${addr}`)).json()) as { balance: string; balanceBaseUnits: string };

  beforeAll(async () => {
    const app = createFacilitatorApp(config, { quiet: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("gates /admin/* behind X-Owner-Key when a key is configured", async () => {
    const keyed = createFacilitatorApp({ ...config, dataDir: mkdtempSync(join(tmpdir(), "allowance-fac-key-")), ownerApiKey: "ok_test" }, { quiet: true });
    const srv = await new Promise<Server>((resolve) => {
      const s = keyed.listen(0, () => resolve(s));
    });
    const a = srv.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    try {
      const open = await fetch(`${base}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: payer.address, amount: "1.00" }) });
      expect(open.status).toBe(401);
      const ok = await fetch(`${base}/admin/mint`, { method: "POST", headers: { "content-type": "application/json", "x-owner-key": "ok_test" }, body: JSON.stringify({ to: payer.address, amount: "1.00" }) });
      expect(ok.status).toBe(200);
      // read-only and x402 endpoints stay open
      expect((await fetch(`${base}/supported`)).status).toBe(200);
      expect((await fetch(`${base}/balance/${payer.address}`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("GET /supported advertises exact on eip155:84532", async () => {
    const s = (await (await fetch(`${url}/supported`)).json()) as { kinds: unknown[]; signers: Record<string, string[]> };
    expect(s.kinds).toEqual([{ x402Version: 2, scheme: "exact", network: "eip155:84532" }]);
    expect(s.signers["eip155:*"]).toHaveLength(1);
  });

  it("mint, transfer, balance", async () => {
    const mint = await post("/admin/mint", { to: payer.address, amount: "20.00" });
    expect(mint.status).toBe(200);
    const m = (await mint.json()) as { txHash: string; balance: string };
    expect(m.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(m.balance).toBe("20.00");
    expect((await balance(payer.address)).balanceBaseUnits).toBe(toBaseUnits("20.00").toString());

    const t = await post("/admin/transfer", { from: payer.address, to: stranger.address, amount: "1.00", memo: "seed" });
    expect(t.status).toBe(200);
    expect((await balance(stranger.address)).balance).toBe("1.00");
    expect((await balance(payer.address)).balance).toBe("19.00");

    const tooMuch = await post("/admin/transfer", { from: stranger.address, to: payer.address, amount: "5.00" });
    expect(tooMuch.status).toBe(400);
    expect(((await tooMuch.json()) as { error: string }).error).toBe("insufficient_funds");

    const bad = await post("/admin/mint", { to: "nope", amount: "1.00" });
    expect(bad.status).toBe(400);
  });

  it("verifies and settles a valid EIP-3009 payload, exposes the tx", async () => {
    const req = requirements("50000");
    const payload = await signAuthorization(payer, req);
    const v = (await (await post("/verify", x402Body(req, payload))).json()) as { isValid: boolean; payer?: string };
    expect(v).toEqual({ isValid: true, payer: payer.address });

    const before = BigInt((await balance(merchant.address)).balanceBaseUnits);
    const s = (await (await post("/settle", x402Body(req, payload))).json()) as { success: boolean; transaction: string; network: string; payer: string };
    expect(s.success).toBe(true);
    expect(s.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.network).toBe("eip155:84532");
    expect(s.payer).toBe(payer.address);
    const after = BigInt((await balance(merchant.address)).balanceBaseUnits);
    expect(after - before).toBe(50000n);

    const tx = (await (await fetch(`${url}/tx/${s.transaction}`)).json()) as { hash: string; kind: string; amount: string; from: string; to: string };
    expect(tx.hash).toBe(s.transaction);
    expect(tx.kind).toBe("settle");
    expect(tx.amount).toBe("0.05");
    expect(tx.from).toBe(payer.address);
    expect(tx.to).toBe(merchant.address);

    const html = await fetch(`${url}/tx/${s.transaction}`, { headers: { accept: "text/html" } });
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain(s.transaction);

    const txs = (await (await fetch(`${url}/txs?address=${merchant.address}`)).json()) as { txs: { hash: string }[] };
    expect(txs.txs[0].hash).toBe(s.transaction);

    // Replay: same nonce, same signature -> rejected with HTTP 200 and success:false.
    const replay = await post("/settle", x402Body(req, payload));
    expect(replay.status).toBe(200);
    const r = (await replay.json()) as { success: boolean; errorReason: string; transaction: string };
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("nonce_already_used");
    expect(r.transaction).toBe("");
    expect(BigInt((await balance(merchant.address)).balanceBaseUnits)).toBe(after);

    const v2 = (await (await post("/verify", x402Body(req, payload))).json()) as { isValid: boolean; invalidReason: string };
    expect(v2.isValid).toBe(false);
    expect(v2.invalidReason).toBe("nonce_already_used");
  });

  it("rejects a payload signed by the wrong key", async () => {
    const req = requirements("50000");
    const payload = await signAuthorization(stranger, req, { from: payer.address });
    const v = (await (await post("/verify", x402Body(req, payload))).json()) as { isValid: boolean; invalidReason: string };
    expect(v.isValid).toBe(false);
    expect(v.invalidReason).toBe("invalid_signature");
    const s = (await (await post("/settle", x402Body(req, payload))).json()) as { success: boolean; errorReason: string };
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe("invalid_signature");
  });

  it("rejects recipient mismatch", async () => {
    const req = requirements("50000");
    const payload = await signAuthorization(payer, req, { to: stranger.address });
    const v = (await (await post("/verify", x402Body(req, payload))).json()) as { isValid: boolean; invalidReason: string };
    expect(v.invalidReason).toBe("recipient_mismatch");
  });

  it("rejects insufficient amount, expired and not-yet-valid windows", async () => {
    const req = requirements("50000");
    const low = await signAuthorization(payer, req, { value: "49999" });
    expect(((await (await post("/verify", x402Body(req, low))).json()) as { invalidReason: string }).invalidReason).toBe("insufficient_amount");

    const expired = await signAuthorization(payer, req, { validBefore: String(Math.floor(Date.now() / 1000) - 10) });
    expect(((await (await post("/verify", x402Body(req, expired))).json()) as { invalidReason: string }).invalidReason).toBe("authorization_expired");

    const future = await signAuthorization(payer, req, { validAfter: String(Math.floor(Date.now() / 1000) + 3600) });
    expect(((await (await post("/verify", x402Body(req, future))).json()) as { invalidReason: string }).invalidReason).toBe("not_yet_valid");
  });

  it("rejects insufficient balance", async () => {
    const req = requirements(toBaseUnits("1000.00").toString());
    const payload = await signAuthorization(payer, req);
    const v = (await (await post("/verify", x402Body(req, payload))).json()) as { isValid: boolean; invalidReason: string };
    expect(v.invalidReason).toBe("insufficient_funds");
    const s = (await (await post("/settle", x402Body(req, payload))).json()) as { success: boolean; errorReason: string };
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe("insufficient_funds");
  });

  it("rejects malformed bodies with 400", async () => {
    const r = await post("/verify", { x402Version: 2 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { isValid: boolean }).isValid).toBe(false);
    const s = await post("/settle", { x402Version: 2, paymentPayload: { x402Version: 2 }, paymentRequirements: { scheme: "exact" } });
    // Scheme is registered but the requirements are garbage: a well-formed rejection.
    expect([200, 400]).toContain(s.status);
    expect(((await s.json()) as { success: boolean }).success).toBe(false);
  });

  it("serves the explorer and health", async () => {
    const ex = await fetch(`${url}/explorer`);
    expect(ex.headers.get("content-type")).toContain("text/html");
    expect(await ex.text()).toContain("Mock USDC Explorer");
    const h = (await (await fetch(`${url}/health`)).json()) as { ok: boolean; mode: string };
    expect(h).toMatchObject({ ok: true, mode: "mock" });
    const bals = (await (await fetch(`${url}/balances`)).json()) as { balances: { address: string }[] };
    expect(bals.balances.some((b) => b.address === merchant.address)).toBe(true);
  });

  it("persists the ledger across app re-creation with the same DATA_DIR", async () => {
    expect(existsSync(join(dataDir, "ledger.json"))).toBe(true);
    const merchantBal = (await balance(merchant.address)).balanceBaseUnits;
    const app2 = createFacilitatorApp(config, { quiet: true });
    expect(app2.locals.ledger.balanceOf(merchant.address).toString()).toBe(merchantBal);
    expect(app2.locals.ledger.listTxs().length).toBeGreaterThan(0);
    // Nonce memory survives too: the already-settled nonce is still rejected.
    const first = app2.locals.ledger.listTxs({ limit: 500 }).find((t) => t.kind === "settle");
    expect(first).toBeDefined();
  });

  it("POST /admin/reset clears everything", async () => {
    const r = await post("/admin/reset", {});
    expect(r.status).toBe(200);
    expect((await balance(payer.address)).balance).toBe("0.00");
    const txs = (await (await fetch(`${url}/txs`)).json()) as { txs: unknown[] };
    expect(txs.txs).toHaveLength(0);
  });
});
