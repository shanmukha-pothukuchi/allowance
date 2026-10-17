import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getAddress, toHex } from "viem";
import type { Address, Hex, LocalAccount } from "viem";
import { getRandomValues } from "node:crypto";
import type { X402PaymentRequired, X402PaymentRequirements } from "@allowance/shared";

/** EIP-712 types for EIP-3009 transferWithAuthorization (same as @x402/evm `authorizationTypes`). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface SignedAuthorization {
  authorization: Eip3009Authorization;
  signature: Hex;
}

export interface SignOptions {
  /** Override the random nonce (tests). */
  nonce?: Hex;
  /** Override "now" in unix seconds (tests). */
  nowSeconds?: number;
}

/** "eip155:84532" → 84532 */
export function chainIdOf(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`Unsupported network: ${network}`);
  return Number(m[1]);
}

/** EIP-712 domain for the asset named in the requirements. */
export function eip712Domain(requirements: X402PaymentRequirements) {
  const name = requirements.extra?.name;
  const version = requirements.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`EIP-712 domain (extra.name, extra.version) missing for asset ${requirements.asset}`);
  }
  return {
    name,
    version,
    chainId: chainIdOf(requirements.network),
    verifyingContract: getAddress(requirements.asset),
  } as const;
}

export function randomNonce(): Hex {
  return toHex(getRandomValues(new Uint8Array(32)));
}

/**
 * Sign an EIP-3009 TransferWithAuthorization for the given x402 requirements.
 * Output matches exactly what @x402/evm's ExactEvmScheme produces.
 */
export async function signTransferAuthorization(
  account: LocalAccount,
  requirements: X402PaymentRequirements,
  opts: SignOptions = {},
): Promise<SignedAuthorization> {
  if (requirements.scheme !== "exact") throw new Error(`Unsupported scheme: ${requirements.scheme}`);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const authorization: Eip3009Authorization = {
    from: getAddress(account.address),
    to: getAddress(requirements.payTo),
    value: requirements.amount,
    validAfter: "0",
    validBefore: String(now + Number(requirements.maxTimeoutSeconds)),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: eip712Domain(requirements),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { authorization, signature };
}

/** Assemble the x402 v2 PaymentPayload the way @x402/core's client does. */
export function buildPaymentPayload(
  paymentRequired: Pick<X402PaymentRequired, "x402Version" | "resource">,
  requirements: X402PaymentRequirements,
  signed: SignedAuthorization,
): PaymentPayload {
  return {
    x402Version: paymentRequired.x402Version || 2,
    resource: paymentRequired.resource,
    accepted: requirements as PaymentRequirements,
    payload: { signature: signed.signature, authorization: signed.authorization },
  };
}

/** Value for the PAYMENT-SIGNATURE header. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return encodePaymentSignatureHeader(payload);
}

export type { PaymentPayload };
