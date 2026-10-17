/**
 * Bounty payouts from the company wallet.
 *
 * Mock mode: sign an EIP-3009 TransferWithAuthorization from the company account to the
 * agent and POST it to the mock facilitator's /settle, so payouts go through the exact same
 * signature verification + nonce replay protection as x402 payments (ARCHITECTURE §12).
 *
 * Chain mode (CHAIN_MODE=base-sepolia): a plain USDC `transfer` sent with viem. The company
 * wallet needs Base Sepolia USDC *and* a little testnet ETH for gas. Untested in the demo.
 */
import { createWalletClient, erc20Abi, getAddress, http, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  type AppConfig,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NETWORK,
  USDC_BASE_SEPOLIA,
  USDC_EIP712,
  explorerTxUrl,
  parseBaseUnits,
  toDollars,
} from "@allowance/shared";
import type { CompanyAccount } from "./wallet.js";

export interface PayoutContext {
  bountyId: string;
  claimId: string;
}

export interface PayoutResult {
  txHash: Hex;
  explorerUrl: string;
}

export type PayoutFn = (to: Address, amountBaseUnits: bigint | string, ctx: PayoutContext) => Promise<PayoutResult>;

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

type PayoutConfig = Pick<AppConfig, "chainMode" | "facilitatorUrl" | "baseSepoliaRpcUrl">;

export function createPayout(config: PayoutConfig, account: CompanyAccount): PayoutFn {
  return async (to, amountBaseUnits, ctx) => {
    const amount = parseBaseUnits(amountBaseUnits);
    if (amount <= 0n) throw new Error("payout amount must be positive");
    const recipient = getAddress(to);
    const txHash = config.chainMode === "mock" ? await settleViaFacilitator(config, account, recipient, amount, ctx) : await transferOnChain(config, account, recipient, amount);
    return { txHash, explorerUrl: explorerTxUrl(txHash, config.chainMode, config.facilitatorUrl) };
  };
}

async function settleViaFacilitator(config: PayoutConfig, account: CompanyAccount, to: Address, amount: bigint, ctx: PayoutContext): Promise<Hex> {
  const requirements = {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: USDC_BASE_SEPOLIA,
    payTo: to,
    amount: amount.toString(),
    maxTimeoutSeconds: 300,
    extra: { name: USDC_EIP712.name, version: USDC_EIP712.version },
  };
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to,
    value: amount.toString(),
    validAfter: "0",
    validBefore: String(now + requirements.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: { name: USDC_EIP712.name, version: USDC_EIP712.version, chainId: BASE_SEPOLIA_CHAIN_ID, verifyingContract: USDC_BASE_SEPOLIA },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: amount,
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const body = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: `agent-work://${ctx.bountyId}/${ctx.claimId}`, description: `Bounty payout: ${ctx.bountyId}` },
      accepted: requirements,
      payload: { signature, authorization },
    },
    paymentRequirements: requirements,
  };
  const res = await fetch(`${config.facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; transaction?: string; errorReason?: string; errorMessage?: string };
  if (!res.ok || !json.success || !json.transaction) {
    throw new Error(`payout settle failed (${res.status}): ${json.errorReason ?? "unknown"}${json.errorMessage ? ` - ${json.errorMessage}` : ""}`);
  }
  console.log(`[merchant] paid $${toDollars(amount)} to ${to} for ${ctx.bountyId}/${ctx.claimId} tx=${json.transaction}`);
  return json.transaction as Hex;
}

async function transferOnChain(config: PayoutConfig, account: CompanyAccount, to: Address, amount: bigint): Promise<Hex> {
  // Requires testnet ETH in the company wallet for gas. Never mainnet.
  const client = createWalletClient({ account, chain: baseSepolia, transport: http(config.baseSepoliaRpcUrl) });
  const hash = await client.writeContract({
    address: USDC_BASE_SEPOLIA,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  console.log(`[merchant] on-chain payout $${toDollars(amount)} to ${to} tx=${hash}`);
  return hash;
}
