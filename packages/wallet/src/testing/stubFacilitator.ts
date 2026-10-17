/**
 * Minimal in-memory stand-in for apps/mock-facilitator, for tests only.
 * Implements the subset of ARCHITECTURE §5 the wallet uses: /balance, /settle, /admin/mint, /health.
 * Signatures are verified with viem, nonces are single-use, balances move.
 */
import express from "express";
import type { Server } from "node:http";
import { getAddress, keccak256, toHex, verifyTypedData } from "viem";
import type { Address, Hex } from "viem";
import { toBaseUnits, toDollars } from "@allowance/shared";

export interface StubFacilitator {
  url: string;
  balances: Map<string, bigint>;
  txs: { hash: Hex; from: Address; to: Address; amountBaseUnits: string; kind: string }[];
  /** Force every /settle to fail with this reason (tests). */
  failSettleWith?: string;
  mint(address: Address, dollars: string): void;
  close(): Promise<void>;
}

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export async function startStubFacilitator(): Promise<StubFacilitator> {
  const balances = new Map<string, bigint>();
  const usedNonces = new Set<string>();
  const txs: StubFacilitator["txs"] = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const key = (a: string) => getAddress(a);
  const fakeHash = (seed: string): Hex => keccak256(toHex(`${seed}:${txs.length}:${Date.now()}`));

  app.get("/health", (_req, res) => res.json({ ok: true, mode: "mock" }));
  app.get("/balance/:address", (req, res) => {
    const address = key(req.params.address);
    const bal = balances.get(address) ?? 0n;
    res.json({ address, balanceBaseUnits: bal.toString(), balance: toDollars(bal) });
  });
  app.post("/admin/mint", (req, res) => {
    const to = key(req.body.to);
    const amount = toBaseUnits(req.body.amount);
    balances.set(to, (balances.get(to) ?? 0n) + amount);
    const hash = fakeHash(`mint:${to}`);
    txs.push({ hash, from: "0x0000000000000000000000000000000000000000", to, amountBaseUnits: amount.toString(), kind: "mint" });
    res.json({ txHash: hash, balance: toDollars(balances.get(to)!) });
  });
  app.get("/tx/:hash", (req, res) => {
    const tx = txs.find((t) => t.hash.toLowerCase() === String(req.params.hash).toLowerCase());
    if (!tx) return res.status(404).json({ error: "not_found" });
    res.json(tx);
  });

  app.post("/settle", async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    const fail = (errorReason: string) =>
      res.json({ success: false, errorReason, transaction: "", network: paymentRequirements?.network ?? "" });
    if (stub.failSettleWith) return fail(stub.failSettleWith);
    const auth = paymentPayload?.payload?.authorization;
    const signature = paymentPayload?.payload?.signature as Hex;
    if (!auth || !signature) return fail("invalid_payload");
    const chainId = Number(String(paymentRequirements.network).split(":")[1]);
    const valid = await verifyTypedData({
      address: auth.from,
      domain: {
        name: paymentRequirements.extra.name,
        version: paymentRequirements.extra.version,
        chainId,
        verifyingContract: getAddress(paymentRequirements.asset),
      },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(auth.from),
        to: getAddress(auth.to),
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    });
    if (!valid) return fail("invalid_signature");
    if (getAddress(auth.to) !== getAddress(paymentRequirements.payTo)) return fail("recipient_mismatch");
    if (BigInt(auth.value) < BigInt(paymentRequirements.amount)) return fail("insufficient_amount");
    if (BigInt(auth.validBefore) < BigInt(Math.floor(Date.now() / 1000))) return fail("expired");
    const nonceKey = `${getAddress(auth.from)}:${auth.nonce}`;
    if (usedNonces.has(nonceKey)) return fail("nonce_already_used");
    const from = key(auth.from);
    const to = key(auth.to);
    const value = BigInt(auth.value);
    if ((balances.get(from) ?? 0n) < value) return fail("insufficient_funds");
    usedNonces.add(nonceKey);
    balances.set(from, balances.get(from)! - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
    const hash = fakeHash(`settle:${nonceKey}`);
    txs.push({ hash, from, to, amountBaseUnits: value.toString(), kind: "settle" });
    res.json({ success: true, transaction: hash, network: paymentRequirements.network, payer: from });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const stub: StubFacilitator = {
    url: `http://127.0.0.1:${port}`,
    balances,
    txs,
    mint(address, dollars) {
      const a = key(address);
      balances.set(a, (balances.get(a) ?? 0n) + toBaseUnits(dollars));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return stub;
}
