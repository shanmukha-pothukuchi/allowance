/**
 * The bridge's merchant wallet: the x402 `payTo` for every store. Generated once into
 * `DATA_DIR/shopify-bridge-key.json` (mode 0600). The key is never logged; only the address is.
 * The bridge only receives payments, so it needs no self-funding.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export type BridgeAccount = PrivateKeyAccount;

export function bridgeKeyPath(dataDir: string): string {
  return join(dataDir, "shopify-bridge-key.json");
}

export function loadBridgeAccount(dataDir: string, log: (msg: string) => void = (m) => console.log(`[shopify] ${m}`)): BridgeAccount {
  const file = bridgeKeyPath(dataDir);
  if (existsSync(file)) {
    try {
      const { privateKey } = JSON.parse(readFileSync(file, "utf8")) as { privateKey: `0x${string}` };
      const account = privateKeyToAccount(privateKey);
      log(`bridge wallet ${account.address} (from ${file})`);
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
  log(`generated bridge wallet ${account.address} (key stored in ${file})`);
  return account;
}
