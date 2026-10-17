/**
 * Custom x402 `SchemeNetworkFacilitator` for scheme "exact" on EVM networks, backed by
 * the in-memory Ledger instead of a chain.
 *
 * Verification is REAL: the EIP-712 TransferWithAuthorization signature is checked with
 * viem exactly as the USDC contract would. Only settlement is simulated (ledger move,
 * fake tx hash). This means the wallet-service's signer and the official @x402 client
 * produce payloads that are verified byte-for-byte like on Base Sepolia.
 */
import { getAddress, isAddress, isHex, verifyTypedData, type Address, type Hex } from "viem";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
  Network,
} from "@x402/core/types";
import type { Ledger } from "./ledger.js";

/** EIP-712 types for EIP-3009 TransferWithAuthorization (same as @x402/evm `authorizationTypes`). */
export const AUTHORIZATION_TYPES = {
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

export interface ExactEvmPayload {
  signature: Hex;
  authorization: Eip3009Authorization;
}

export type VerifyFailure = {
  isValid: false;
  invalidReason: string;
  invalidMessage: string;
  payer?: string;
};

function chainIdOf(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : undefined;
}

function parsePayload(raw: unknown): ExactEvmPayload | string {
  if (!raw || typeof raw !== "object") return "payload missing";
  const p = raw as Record<string, unknown>;
  const a = p.authorization as Record<string, unknown> | undefined;
  if (!isHex(p.signature as string)) return "payload.signature must be hex";
  if (!a || typeof a !== "object") return "payload.authorization missing";
  if (!isAddress(a.from as string)) return "authorization.from invalid";
  if (!isAddress(a.to as string)) return "authorization.to invalid";
  for (const k of ["value", "validAfter", "validBefore"]) {
    if (!/^\d+$/.test(String(a[k]))) return `authorization.${k} must be an integer string`;
  }
  if (!isHex(a.nonce as string) || (a.nonce as string).length !== 66) return "authorization.nonce must be 32 bytes hex";
  return {
    signature: p.signature as Hex,
    authorization: {
      from: a.from as Address,
      to: a.to as Address,
      value: String(a.value),
      validAfter: String(a.validAfter),
      validBefore: String(a.validBefore),
      nonce: a.nonce as Hex,
    },
  };
}

export class LedgerExactEvmFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "eip155:*";

  constructor(
    private readonly ledger: Ledger,
    private readonly signerAddress: Address,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [this.signerAddress];
  }

  /** Full verification. Returns a VerifyResponse; never throws for bad input. */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.check(payload, requirements);
    if ("isValid" in r) return r;
    return { isValid: true, payer: r.authorization.from };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const r = await this.check(payload, requirements);
    if ("isValid" in r) {
      return {
        success: false,
        errorReason: r.invalidReason,
        errorMessage: r.invalidMessage,
        transaction: "",
        network: requirements.network,
        payer: r.payer,
      };
    }
    const { authorization } = r;
    try {
      const tx = this.ledger.settle(
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        authorization.nonce,
        payload.resource?.description ?? payload.resource?.url,
      );
      return { success: true, transaction: tx.hash, network: requirements.network, payer: authorization.from };
    } catch (err) {
      const reason = (err as Error).message;
      return {
        success: false,
        errorReason: reason,
        errorMessage: reason,
        transaction: "",
        network: requirements.network,
        payer: authorization.from,
      };
    }
  }

  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyFailure | { authorization: Eip3009Authorization }> {
    const parsed = parsePayload(payload.payload);
    if (typeof parsed === "string") {
      return { isValid: false, invalidReason: "invalid_payload", invalidMessage: parsed };
    }
    const { signature, authorization } = parsed;
    const payer = authorization.from;
    const fail = (invalidReason: string, invalidMessage: string): VerifyFailure => ({
      isValid: false,
      invalidReason,
      invalidMessage,
      payer,
    });

    if (requirements.scheme !== "exact") return fail("unsupported_scheme", `scheme ${requirements.scheme}`);
    const chainId = chainIdOf(requirements.network);
    if (chainId === undefined) return fail("unsupported_network", `network ${requirements.network}`);
    if (!isAddress(requirements.asset)) return fail("invalid_payment_requirements", "asset is not an address");
    if (!isAddress(requirements.payTo)) return fail("invalid_payment_requirements", "payTo is not an address");
    const name = requirements.extra?.name;
    const version = requirements.extra?.version;
    if (typeof name !== "string" || typeof version !== "string") {
      return fail("invalid_payment_requirements", "extra.name and extra.version (EIP-712 domain) are required");
    }

    // 1. Signature (real EIP-712 verification with viem).
    let ok = false;
    try {
      ok = await verifyTypedData({
        address: payer,
        domain: { name, version, chainId, verifyingContract: getAddress(requirements.asset) },
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
        signature,
      });
    } catch {
      ok = false;
    }
    if (!ok) return fail("invalid_signature", "EIP-712 signature does not match authorization.from");

    // 2. Recipient.
    if (getAddress(authorization.to) !== getAddress(requirements.payTo)) {
      return fail("recipient_mismatch", `authorization.to ${authorization.to} != payTo ${requirements.payTo}`);
    }

    // 3. Amount.
    const value = BigInt(authorization.value);
    if (!/^\d+$/.test(requirements.amount)) return fail("invalid_payment_requirements", "amount must be base units");
    if (value < BigInt(requirements.amount)) {
      return fail("insufficient_amount", `authorized ${value} < required ${requirements.amount}`);
    }

    // 4. Time window.
    const now = this.now();
    if (BigInt(authorization.validBefore) <= BigInt(now)) {
      return fail("authorization_expired", `validBefore ${authorization.validBefore} <= now ${now}`);
    }
    if (BigInt(authorization.validAfter) > BigInt(now)) {
      return fail("not_yet_valid", `validAfter ${authorization.validAfter} > now ${now}`);
    }

    // 5. Nonce replay.
    if (this.ledger.isNonceUsed(payer, authorization.nonce)) {
      return fail("nonce_already_used", `nonce ${authorization.nonce} already consumed`);
    }

    // 6. Balance.
    const balance = this.ledger.balanceOf(payer);
    if (balance < value) {
      return fail("insufficient_funds", `balance ${balance} < value ${value}`);
    }

    return { authorization };
  }
}
