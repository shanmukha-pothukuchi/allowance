/**
 * Quantcomm's earnings wallet: the x402 `payTo` for every paid request. Agents' USDC lands here.
 * Generated once into `DATA_DIR/quantcomm-bridge-key.json` (mode 0600). The key is never logged;
 * only the address is. The wallet only receives payments, so it needs no self-funding.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export type EarningsAccount = PrivateKeyAccount;

export function earningsKeyPath(dataDir: string): string {
  return join(dataDir, "quantcomm-bridge-key.json");
}

export function loadEarningsAccount(dataDir: string, log: (msg: string) => void = (m) => console.log(`[quantcomm] ${m}`)): EarningsAccount {
  const file = earningsKeyPath(dataDir);
  if (existsSync(file)) {
    try {
      const { privateKey } = JSON.parse(readFileSync(file, "utf8")) as { privateKey: `0x${string}` };
      const account = privateKeyToAccount(privateKey);
      log(`Quantcomm earnings wallet ${account.address} (from ${file})`);
      return account;
    } catch (err) {
      // Never overwrite a key file we could not read: it may hold received funds.
      throw new Error(`could not read ${file} (${(err as Error).message}); fix or remove it`);
    }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ address: account.address, privateKey, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  log(`generated the Quantcomm earnings wallet ${account.address} (key stored in ${file})`);
  return account;
}
