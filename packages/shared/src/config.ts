import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type ChainMode = "mock" | "base-sepolia";

/** Base Sepolia USDC (Circle's official testnet deployment). NEVER mainnet. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_NETWORK = "eip155:84532" as const;
/** EIP-712 domain for Base Sepolia USDC (matches @x402/evm default asset table). */
export const USDC_EIP712 = { name: "USDC", version: "2" } as const;

/**
 * Minimal .env loader (no dependency). Loads `<repoRoot>/.env` once, never overriding
 * variables already present in the environment.
 */
let loaded = false;
export function loadDotenv(root = findRepoRoot()): void {
  if (loaded) return;
  loaded = true;
  const file = resolve(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** Walk up from cwd until a package.json with "workspaces" is found. */
export function findRepoRoot(from = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    const pj = resolve(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const j = JSON.parse(readFileSync(pj, "utf8"));
        if (j.workspaces) return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

export interface AppConfig {
  chainMode: ChainMode;
  repoRoot: string;
  dataDir: string;
  facilitatorPort: number;
  facilitatorUrl: string;
  walletServicePort: number;
  walletServiceUrl: string;
  merchantPort: number;
  merchantUrl: string;
  dashboardPort: number;
  telegramBotToken?: string;
  telegramOwnerChatId?: string;
  baseSepoliaRpcUrl: string;
  /** Facilitator used by x402 middleware. Mock mode: our local one. Chain mode: X402_FACILITATOR_URL. */
  x402FacilitatorUrl: string;
  merchantPrivateKey?: `0x${string}`;
  ownerApiKey?: string;
  network: typeof BASE_SEPOLIA_NETWORK;
  usdcAddress: typeof USDC_BASE_SEPOLIA;
}

export function loadConfig(): AppConfig {
  loadDotenv();
  const env = process.env;
  const chainMode = (env.CHAIN_MODE === "base-sepolia" ? "base-sepolia" : "mock") as ChainMode;
  const repoRoot = findRepoRoot();
  const facilitatorPort = Number(env.FACILITATOR_PORT ?? 4030);
  const walletServicePort = Number(env.WALLET_SERVICE_PORT ?? 4010);
  const merchantPort = Number(env.MERCHANT_PORT ?? 4021);
  const facilitatorUrl = env.FACILITATOR_URL ?? `http://localhost:${facilitatorPort}`;
  return {
    chainMode,
    repoRoot,
    dataDir: resolve(repoRoot, env.DATA_DIR ?? ".data"),
    facilitatorPort,
    facilitatorUrl,
    walletServicePort,
    walletServiceUrl: env.WALLET_SERVICE_URL ?? `http://localhost:${walletServicePort}`,
    merchantPort,
    merchantUrl: env.MERCHANT_URL ?? `http://localhost:${merchantPort}`,
    dashboardPort: Number(env.DASHBOARD_PORT ?? 4040),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramOwnerChatId: env.TELEGRAM_OWNER_CHAT_ID || undefined,
    baseSepoliaRpcUrl: env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    x402FacilitatorUrl:
      chainMode === "mock" ? facilitatorUrl : (env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator"),
    merchantPrivateKey: (env.MERCHANT_PRIVATE_KEY as `0x${string}` | undefined) || undefined,
    ownerApiKey: env.OWNER_API_KEY || undefined,
    network: BASE_SEPOLIA_NETWORK,
    usdcAddress: USDC_BASE_SEPOLIA,
  };
}

/** Explorer link for a tx hash in the active mode. */
export function explorerTxUrl(txHash: string, chainMode: ChainMode, facilitatorUrl: string): string {
  return chainMode === "mock" ? `${facilitatorUrl}/tx/${txHash}` : `https://sepolia.basescan.org/tx/${txHash}`;
}
