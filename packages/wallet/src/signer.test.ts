import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { USDC_BASE_SEPOLIA } from "@allowance/shared";
import type { X402PaymentRequired, X402PaymentRequirements } from "@allowance/shared";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildPaymentPayload,
  encodePaymentHeader,
  signTransferAuthorization,
} from "./signer.js";

const PAY_TO = "0x9999999999999999999999999999999999999999";
const requirements: X402PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: USDC_BASE_SEPOLIA.toLowerCase(),
  amount: "50000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  resource: { url: "http://localhost:4021/api/weather?city=Paris", description: "Weather" },
  accepts: [requirements],
};

describe("signTransferAuthorization", () => {
  it("produces the documented payload shape and a signature that verifies", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const now = 1_800_000_000;
    const { authorization, signature } = await signTransferAuthorization(account, requirements, { nowSeconds: now });

    expect(authorization).toEqual({
      from: account.address,
      to: PAY_TO,
      value: "50000",
      validAfter: "0",
      validBefore: String(now + 300),
      nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });

    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: 50000n,
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });
    expect(ok).toBe(true);
  });

  it("uses a fresh nonce per signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const a = await signTransferAuthorization(account, requirements);
    const b = await signTransferAuthorization(account, requirements);
    expect(a.authorization.nonce).not.toBe(b.authorization.nonce);
    expect(a.signature).not.toBe(b.signature);
  });

  it("rejects requirements without EIP-712 domain info or with another scheme", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(signTransferAuthorization(account, { ...requirements, extra: {} })).rejects.toThrow(/EIP-712/);
    await expect(signTransferAuthorization(account, { ...requirements, scheme: "upto" })).rejects.toThrow(/scheme/);
  });

  it("builds and encodes a PaymentPayload that round-trips through @x402/core", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signTransferAuthorization(account, requirements);
    const payload = buildPaymentPayload(paymentRequired, requirements, signed);
    const header = encodePaymentHeader(payload);
    const decoded = decodePaymentSignatureHeader(header);
    expect(decoded).toEqual({
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { signature: signed.signature, authorization: signed.authorization },
    });
  });
});
