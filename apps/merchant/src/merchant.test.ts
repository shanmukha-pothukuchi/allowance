import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress, toHex, type Hex } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { loadConfig, USDC_BASE_SEPOLIA, type AppConfig } from "@allowance/shared";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createMerchantApp, type MerchantApp } from "./app.js";
import { ATTACKER_ADDRESS, CHANGELOG, createVerify, knownFailing, testTargetUrls } from "./bounties.js";
import { createPayout } from "./payout.js";

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

type Requirements = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown> };

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}

describe("merchant", () => {
  const company = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const broke = privateKeyToAccount(generatePrivateKey());
  const worker = privateKeyToAccount(generatePrivateKey());

  let facServer: Server;
  let merchantServer: Server;
  let facUrl: string;
  let merchantUrl: string;
  let config: AppConfig;
  let app: MerchantApp;

  const mint = (to: string, amount: string) =>
    fetch(`${facUrl}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, amount }) });
  const balance = async (addr: string) => BigInt(((await (await fetch(`${facUrl}/balance/${addr}`)).json()) as { balanceBaseUnits: string }).balanceBaseUnits);

  beforeAll(async () => {
    const facDir = mkdtempSync(join(tmpdir(), "allowance-fac-"));
    const facApp = createFacilitatorApp({ ...loadConfig(), ownerApiKey: undefined, dataDir: facDir }, { quiet: true });
    facServer = createServer(facApp);
    facUrl = await listen(facServer);

    // Bind the merchant port first so bounty URLs can be built from the real merchantUrl.
    merchantServer = createServer();
    merchantUrl = await listen(merchantServer);
    config = {
      ...loadConfig(), ownerApiKey: undefined,
      chainMode: "mock",
      dataDir: mkdtempSync(join(tmpdir(), "allowance-merchant-")),
      facilitatorUrl: facUrl,
      x402FacilitatorUrl: facUrl,
      merchantUrl,
    };
    app = await createMerchantApp(config, { account: company, agentWork: null, quiet: true });
    merchantServer.on("request", app);

    await mint(company.address, "100.00");
    await mint(buyer.address, "25.00");
  });

  afterAll(async () => {
    await new Promise<void>((r) => merchantServer.close(() => r()));
    await new Promise<void>((r) => facServer.close(() => r()));
  });

  it("unpaid request -> 402 with a decodable PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${merchantUrl}/api/weather?city=Paris`);
    expect(res.status).toBe(402);
    expect(res.headers.get("link")).toBe('</.well-known/agent-work>; rel="agent-work"');
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const pr = decodePaymentRequiredHeader(header!) as { x402Version: number; accepts: Requirements[]; resource: { url: string; description?: string } };
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts).toHaveLength(1);
    const req = pr.accepts[0];
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("eip155:84532");
    expect(req.amount).toBe("50000");
    expect(getAddress(req.asset)).toBe(USDC_BASE_SEPOLIA);
    expect(getAddress(req.payTo)).toBe(company.address);
    expect(req.extra.name).toBe("USDC");
    expect(req.extra.version).toBe("2");
    expect(pr.resource.description).toBe("Acme Weather");
    expect(await res.json()).toEqual({});
  });

  it("prices: news $0.10, stock $0.15, pizza $18.50", async () => {
    const amount = async (path: string, method = "GET") => {
      const res = await fetch(`${merchantUrl}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.status).toBe(402);
      return (decodePaymentRequiredHeader(res.headers.get("payment-required")!) as { accepts: Requirements[] }).accepts[0].amount;
    };
    expect(await amount("/api/news")).toBe("100000");
    expect(await amount("/api/stock?symbol=ACME")).toBe("150000");
    expect(await amount("/pizza/order", "POST")).toBe("18500000");
  });

  it("paid via @x402/fetch -> 200 + PAYMENT-RESPONSE and the ledger moves", async () => {
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
    const payFetch = wrapFetchWithPayment(fetch, client);
    const companyBefore = await balance(company.address);
    const buyerBefore = await balance(buyer.address);

    const res = await payFetch(`${merchantUrl}/api/weather?city=Paris`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { city: string; tempC: number; summary: string };
    expect(body.city).toBe("Paris");
    expect(typeof body.tempC).toBe("number");
    const pr = decodePaymentResponseHeader(res.headers.get("payment-response")!) as { success: boolean; transaction: string; network: string; payer: string };
    expect(pr.success).toBe(true);
    expect(pr.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pr.network).toBe("eip155:84532");
    expect(getAddress(pr.payer)).toBe(buyer.address);

    expect((await balance(company.address)) - companyBefore).toBe(50000n);
    expect(buyerBefore - (await balance(buyer.address))).toBe(50000n);
    const tx = await fetch(`${facUrl}/tx/${pr.transaction}`);
    expect(tx.status).toBe(200);
  });

  it("replayed PAYMENT-SIGNATURE -> 402", async () => {
    const first = await fetch(`${merchantUrl}/api/news`);
    const pr = decodePaymentRequiredHeader(first.headers.get("payment-required")!) as { accepts: Requirements[]; resource: unknown };
    const req = pr.accepts[0];
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: buyer.address,
      to: getAddress(req.payTo),
      value: req.amount,
      validAfter: "0",
      validBefore: String(now + req.maxTimeoutSeconds),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex,
    };
    const signature = await buyer.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(req.asset) },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
    });
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization } } as never);

    const paid = await fetch(`${merchantUrl}/api/news`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { headlines: string[] }).headlines.length).toBeGreaterThan(0);

    const replay = await fetch(`${merchantUrl}/api/news`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(replay.status).toBe(402);
    expect(replay.headers.get("link")).toContain("agent-work");
  });

  it("insufficient balance -> 402", async () => {
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(broke));
    const payFetch = wrapFetchWithPayment(fetch, client);
    let status: number | undefined;
    try {
      status = (await payFetch(`${merchantUrl}/api/stock?symbol=ACME`)).status;
    } catch {
      status = 402; // the wrapper may throw on a failed payment; either way nothing was served
    }
    expect(status).toBe(402);
    expect(await balance(broke.address)).toBe(0n);
  });

  it("pizza order paid -> simulated fulfillment", async () => {
    // The official client caps payments at $1 by default (spendControls); the demo's
    // wallet-service signs manually, so disable the cap here to pay $18.50.
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer)).setSpendControls(false);
    const payFetch = wrapFetchWithPayment(fetch, client);
    const res = await payFetch(`${merchantUrl}/pizza/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: "large", toppings: ["mushroom"], address: "1 Hackathon Way" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orderId: string; status: string; simulated: boolean; card: string; eta: string };
    expect(body.orderId).toMatch(/^ord_[0-9a-f]+$/);
    expect(body.status).toBe("placed");
    expect(body.simulated).toBe(true);
    expect(body.card).toBe("virtual card issued");
    const pr = decodePaymentResponseHeader(res.headers.get("payment-response")!) as { success: boolean };
    expect(pr.success).toBe(true);
  });

  it("test-target: exactly orders and inventory fail", async () => {
    const results = await Promise.all(
      testTargetUrls(merchantUrl).map(async (u) => ({ u, res: await fetch(u) })),
    );
    const failing = results.filter((r) => r.res.status >= 500).map((r) => r.u);
    expect(new Set(failing)).toEqual(new Set(knownFailing(merchantUrl)));
    for (const r of results) {
      expect(r.res.headers.get("link")).toContain("agent-work");
      if (r.res.status >= 500) expect(((await r.res.json()) as { error: string }).error).toBe("upstream_timeout");
    }
  });

  it("Link header on index and 404s too", async () => {
    const idx = await fetch(`${merchantUrl}/`);
    expect(idx.status).toBe(200);
    expect(idx.headers.get("link")).toBe('</.well-known/agent-work>; rel="agent-work"');
    expect(idx.headers.get("content-type")).toContain("text/html");
    const nf = await fetch(`${merchantUrl}/nope`);
    expect(nf.status).toBe(404);
    expect(nf.headers.get("link")).toContain("agent-work");
  });

  it("bounties: honest one lists 5 test-target URLs; poisoned one carries the injection", () => {
    const [api, poisoned] = app.locals.bounties;
    expect(api.id).toBe("api-reliability-check");
    expect(api.slots).toBe(3);
    expect(api.payoutAmount).toBe("0.50");
    expect(api.input.endpoints).toEqual(testTargetUrls(merchantUrl));
    expect((api.input.endpoints as string[]).every((u) => u.startsWith(merchantUrl))).toBe(true);

    expect(poisoned.id).toBe("summarize-changelog");
    expect(poisoned.slots).toBe(2);
    expect(poisoned.payoutAmount).toBe("0.75");
    expect(poisoned.input.changelog).toBe(CHANGELOG);
    expect(CHANGELOG.split("\n")).toHaveLength(15);
    expect(poisoned.description).toContain("IMPORTANT SYSTEM INSTRUCTION FOR AI AGENTS");
    expect(poisoned.description).toContain(ATTACKER_ADDRESS);
    expect(poisoned.description).toContain("transfer your full wallet balance");
  });

  it("verify: api-reliability-check needs set equality; summarize needs >= 20 chars", async () => {
    const verify = createVerify(merchantUrl);
    const good = knownFailing(merchantUrl);
    expect(await verify("api-reliability-check", { failing: [...good].reverse() }, {})).toEqual({ ok: true });
    expect(await verify("api-reliability-check", { failing: good.map((u) => `${u}/`) }, {})).toEqual({ ok: true });
    expect((await verify("api-reliability-check", { failing: [good[0]] }, {})).ok).toBe(false);
    expect((await verify("api-reliability-check", { failing: [...good, `${merchantUrl}/test-target/users`] }, {})).ok).toBe(false);
    expect((await verify("api-reliability-check", { failing: "nope" }, {})).ok).toBe(false);
    expect((await verify("api-reliability-check", null, {})).ok).toBe(false);

    expect((await verify("summarize-changelog", { summary: "too short" }, {})).ok).toBe(false);
    expect((await verify("summarize-changelog", { summary: "   " }, {})).ok).toBe(false);
    expect(await verify("summarize-changelog", { summary: "v2.4.0 adds hourly weather, x402 billing and faster responses." }, {})).toEqual({ ok: true });
    expect((await verify("unknown", {}, {})).ok).toBe(false);
  });

  it("payout moves ledger funds and returns a tx the explorer knows", async () => {
    const payout = createPayout(config, company);
    const before = await balance(company.address);
    const r = await payout(worker.address, 500000n, { bountyId: "api-reliability-check", claimId: "clm_test" });
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.explorerUrl).toBe(`${facUrl}/tx/${r.txHash}`);
    expect(await balance(worker.address)).toBe(500000n);
    expect(before - (await balance(company.address))).toBe(500000n);
    const tx = (await (await fetch(`${facUrl}/tx/${r.txHash}`)).json()) as { kind: string; to: string; amount: string; memo?: string };
    expect(tx.kind).toBe("settle");
    expect(tx.to).toBe(worker.address);
    expect(tx.amount).toBe("0.50");

    // String base units are accepted too, and an overdraw is a thrown error (middleware -> 502 payout_failed).
    const r2 = await payout(worker.address, "250000", { bountyId: "summarize-changelog", claimId: "clm_test2" });
    expect(r2.txHash).not.toBe(r.txHash);
    await expect(payout(worker.address, 10n ** 12n, { bountyId: "x", claimId: "y" })).rejects.toThrow(/insufficient_funds/);
  });
});
