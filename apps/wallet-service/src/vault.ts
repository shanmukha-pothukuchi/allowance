/**
 * The owner vault (docs/ARCHITECTURE.md §20.2): where cash-outs go.
 *
 * - Mock mode: an owner address the wallet creates on first use, with its key in
 *   `DATA_DIR/owner-vault.json` (mode 0600). The key is never served, logged or emitted (the wallet
 *   scrubs it like the agents' keys); it is there so the owner can move the money later.
 * - Chain mode: `OWNER_VAULT_ADDRESS`, an address the owner controls. The wallet never holds its key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "@allowance/shared";

export interface OwnerVault {
  address: Address;
  /** Mock mode only. */
  privateKey?: Hex;
  source: "generated" | "env";
}

export class VaultError extends Error {}

export function vaultPath(dataDir: string): string {
  return join(dataDir, "owner-vault.json");
}

/** The vault if it exists already (no side effects). */
export function existingVault(config: Pick<AppConfig, "chainMode" | "dataDir" | "ownerVaultAddress">): OwnerVault | undefined {
  if (config.chainMode !== "mock") {
    const a = config.ownerVaultAddress;
    return a && isAddress(a) ? { address: getAddress(a), source: "env" } : undefined;
  }
  const file = vaultPath(config.dataDir);
  if (!existsSync(file)) return undefined;
  try {
    const { privateKey } = JSON.parse(readFileSync(file, "utf8")) as { privateKey: Hex };
    return { address: privateKeyToAccount(privateKey).address, privateKey, source: "generated" };
  } catch (err) {
    // Never overwrite a vault we could not read: it holds the owner's cashed-out money.
    throw new VaultError(`could not read ${file} (${(err as Error).message}); fix or remove it`);
  }
}

/** The vault, created on first use in mock mode. Chain mode without OWNER_VAULT_ADDRESS throws. */
export function ensureVault(config: Pick<AppConfig, "chainMode" | "dataDir" | "ownerVaultAddress">, log: (m: string) => void = () => {}): OwnerVault {
  const found = existingVault(config);
  if (found) return found;
  if (config.chainMode !== "mock") throw new VaultError("Set OWNER_VAULT_ADDRESS (an address you control) before agents can cash out on Base Sepolia.");
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(vaultPath(config.dataDir), JSON.stringify({ address, privateKey, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
  log(`created the owner vault ${address} (key in ${vaultPath(config.dataDir)})`);
  return { address, privateKey, source: "generated" };
}
