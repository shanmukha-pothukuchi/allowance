import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  /** Service directory (apps/directory): the catalog of services agents can connect. */
  directoryPort: number;
  directoryUrl: string;
  /** Shopify bridge (apps/shopify-bridge): turns Shopify stores into x402 services. */
  shopifyBridgePort: number;
  shopifyBridgeUrl: string;
  /** Admin API access for the owner's own store (Dev Dashboard app, client credentials grant). */
  shopify: { adminShop?: string; clientId?: string; clientSecret?: string; apiVersion: string };
  /** Agent chat server (apps/agent-chat). Binds to localhost by default: whoever can reach it can instruct agents. */
  agentChatPort: number;
  agentChatHost: string;
  agentChatUrl: string;
  /** OpenAI-compatible chat-completions endpoint for the chat agents (default: NRP managed LLMs). */
  llm: LlmSettings;
  network: typeof BASE_SEPOLIA_NETWORK;
  usdcAddress: typeof USDC_BASE_SEPOLIA;
}

export interface LlmSettings {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Extra JSON merged into every chat-completions body, e.g. {"chat_template_kwargs":{"enable_thinking":false}}. */
  extraBody?: Record<string, unknown>;
}

export const NRP_LLM_BASE_URL = "https://ellm.nrp-nautilus.io/v1";

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    console.warn("[config] LLM_EXTRA_BODY is not a JSON object; ignoring it");
    return undefined;
  }
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
    ownerApiKey: env.OWNER_API_KEY || readOwnerKeyFile(resolve(repoRoot, env.DATA_DIR ?? ".data")),
    shopifyBridgePort: Number(env.SHOPIFY_BRIDGE_PORT ?? 4070),
    shopifyBridgeUrl: env.SHOPIFY_BRIDGE_URL ?? `http://localhost:${Number(env.SHOPIFY_BRIDGE_PORT ?? 4070)}`,
    shopify: {
      adminShop: env.SHOPIFY_ADMIN_SHOP || undefined,
      clientId: env.SHOPIFY_CLIENT_ID || undefined,
      clientSecret: env.SHOPIFY_CLIENT_SECRET || undefined,
      apiVersion: env.SHOPIFY_API_VERSION || "2026-10",
    },
    directoryPort: Number(env.DIRECTORY_PORT ?? 4060),
    directoryUrl: env.DIRECTORY_URL ?? `http://localhost:${Number(env.DIRECTORY_PORT ?? 4060)}`,
    agentChatPort: Number(env.AGENT_CHAT_PORT ?? 4050),
    agentChatHost: env.AGENT_CHAT_HOST ?? "127.0.0.1",
    agentChatUrl: env.AGENT_CHAT_URL ?? `http://localhost:${Number(env.AGENT_CHAT_PORT ?? 4050)}`,
    llm: {
      baseUrl: (env.LLM_BASE_URL || NRP_LLM_BASE_URL).replace(/\/+$/, ""),
      apiKey: env.LLM_API_KEY || undefined,
      model: env.LLM_MODEL || "qwen3",
      extraBody: parseJsonObject(env.LLM_EXTRA_BODY),
    },
    network: BASE_SEPOLIA_NETWORK,
    usdcAddress: USDC_BASE_SEPOLIA,
  };
}

/** Explorer link for a tx hash in the active mode. */
export function explorerTxUrl(txHash: string, chainMode: ChainMode, facilitatorUrl: string): string {
  return chainMode === "mock" ? `${facilitatorUrl}/tx/${txHash}` : `https://sepolia.basescan.org/tx/${txHash}`;
}

/**
 * Owner API key. Owner endpoints (approve, unfreeze, policy, top-up, facilitator /admin/*) must
 * never be callable by an agent that can fetch arbitrary URLs, so a key is always required:
 * `OWNER_API_KEY` from the environment, else one generated into `DATA_DIR/owner-key.json` by
 * `npm run setup` (or by a service on first start). Owner-side clients (dashboard proxy, notifier,
 * demo, setup) read the same file.
 */
export function ownerKeyPath(dataDir: string): string {
  return resolve(dataDir, "owner-key.json");
}

export function readOwnerKeyFile(dataDir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(ownerKeyPath(dataDir), "utf8")) as { ownerApiKey?: string };
    return j.ownerApiKey || undefined;
  } catch {
    return undefined;
  }
}

/** Create the owner key file if it does not exist; returns the key. */
export function ensureOwnerKey(dataDir: string): string {
  const existing = readOwnerKeyFile(dataDir);
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true });
  const ownerApiKey = `ok_${randomBytes(24).toString("hex")}`;
  try {
    // "wx": fail if another service created it first (they all start at once), then use theirs.
    writeFileSync(ownerKeyPath(dataDir), JSON.stringify({ ownerApiKey }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return ownerApiKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    for (let i = 0; i < 20; i++) {
      const theirs = readOwnerKeyFile(dataDir);
      if (theirs) return theirs;
      // The other writer may still be mid-write; wait briefly (synchronously) and re-read.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    throw new Error("owner-key.json exists but could not be read");
  }
}

/** Headers for owner-side HTTP calls. */
export function ownerHeaders(config: Pick<AppConfig, "ownerApiKey">): Record<string, string> {
  return config.ownerApiKey ? { "x-owner-key": config.ownerApiKey } : {};
}
