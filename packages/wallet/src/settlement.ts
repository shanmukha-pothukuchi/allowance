import { createPublicClient, createWalletClient, erc20Abi, getAddress, http } from "viem";
import type { Address, Hex, LocalAccount } from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA_NETWORK,
  USDC_BASE_SEPOLIA,
  USDC_EIP712,
  explorerTxUrl,
  parseBaseUnits,
} from "@allowance/shared";
import type { AppConfig, X402PaymentRequirements, X402SettleResponse } from "@allowance/shared";
import { buildPaymentPayload, signTransferAuthorization } from "./signer.js";

export interface TransferResult {
  txHash: Hex;
  explorerUrl: string;
}

export interface Settlement {
  mode: AppConfig["chainMode"];
  balanceOf(address: Address): Promise<bigint>;
  transfer(account: LocalAccount, to: Address, amountBaseUnits: bigint, memo?: string): Promise<TransferResult>;
}

export class SettlementError extends Error {
  constructor(
    message: string,
    public readonly errorReason: string,
  ) {
    super(message);
    this.name = "SettlementError";
  }
}

/** One code path for both modes; pick by config.chainMode. */
export function createSettlement(config: Pick<AppConfig, "chainMode" | "facilitatorUrl" | "baseSepoliaRpcUrl">): Settlement {
  return config.chainMode === "base-sepolia" ? createChainSettlement(config) : createMockSettlement(config);
}

/** Requirements for a direct EIP-3009 transfer to `to` (mock mode settles it through the facilitator). */
export function transferRequirements(to: Address, amountBaseUnits: bigint): X402PaymentRequirements {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: USDC_BASE_SEPOLIA,
    amount: amountBaseUnits.toString(),
    payTo: getAddress(to),
    maxTimeoutSeconds: 300,
    extra: { name: USDC_EIP712.name, version: USDC_EIP712.version },
  };
}

// ---------------------------------------------------------------------------
// Mock: local facilitator ledger
// ---------------------------------------------------------------------------

export function createMockSettlement(config: Pick<AppConfig, "facilitatorUrl">): Settlement {
  const base = config.facilitatorUrl.replace(/\/+$/, "");
  return {
    mode: "mock",
    async balanceOf(address) {
      const res = await fetch(`${base}/balance/${getAddress(address)}`);
      if (!res.ok) throw new SettlementError(`facilitator balance lookup failed (${res.status})`, "facilitator_error");
      const body = (await res.json()) as { balanceBaseUnits: string };
      return parseBaseUnits(body.balanceBaseUnits);
    },
    async transfer(account, to, amountBaseUnits, memo) {
      const requirements = transferRequirements(to, amountBaseUnits);
      const signed = await signTransferAuthorization(account, requirements);
      const paymentPayload = buildPaymentPayload(
        { x402Version: 2, resource: { url: "allowance://transfer", description: memo ?? "Transfer" } },
        requirements,
        signed,
      );
      const res = await fetch(`${base}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
      });
      if (!res.ok) throw new SettlementError(`facilitator settle failed (${res.status})`, "facilitator_error");
      const body = (await res.json()) as X402SettleResponse;
      if (!body.success) {
        throw new SettlementError(body.errorMessage ?? `settle failed: ${body.errorReason ?? "unknown"}`, body.errorReason ?? "settle_failed");
      }
      const txHash = body.transaction as Hex;
      return { txHash, explorerUrl: explorerTxUrl(txHash, "mock", base) };
    },
  };
}

// ---------------------------------------------------------------------------
// Base Sepolia: real USDC via viem. The agent account needs testnet ETH for gas
// (transfers are plain ERC-20 `transfer` calls sent by the agent key). NEVER mainnet.
// ---------------------------------------------------------------------------

export function createChainSettlement(config: Pick<AppConfig, "baseSepoliaRpcUrl" | "facilitatorUrl">): Settlement {
  const transport = http(config.baseSepoliaRpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  return {
    mode: "base-sepolia",
    async balanceOf(address) {
      return publicClient.readContract({
        address: USDC_BASE_SEPOLIA,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(address)],
      });
    },
    async transfer(account, to, amountBaseUnits) {
      const wallet = createWalletClient({ account, chain: baseSepolia, transport });
      const txHash = await wallet.writeContract({
        address: USDC_BASE_SEPOLIA,
        abi: erc20Abi,
        functionName: "transfer",
        args: [getAddress(to), amountBaseUnits],
      });
      try {
        await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      } catch {
        // The tx is broadcast; the explorer link lets the owner follow it.
      }
      return { txHash, explorerUrl: explorerTxUrl(txHash, "base-sepolia", config.facilitatorUrl) };
    },
  };
}
