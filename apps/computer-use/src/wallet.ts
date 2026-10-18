/**
 * The computer's earnings wallet: the x402 payTo for time, actions and reads. Its key lives in
 * DATA_DIR/computer-use-key.json (0600), created on first start and never logged.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const KEY_FILE = "computer-use-key.json";

export function loadEarningsAccount(dataDir: string, log: (m: string) => void = () => {}): { address: `0x${string}` } {
  const file = join(dataDir, KEY_FILE);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { privateKey?: string };
    if (typeof saved.privateKey === "string" && /^0x[0-9a-fA-F]{64}$/.test(saved.privateKey)) {
      return { address: privateKeyToAccount(saved.privateKey as `0x${string}`).address };
    }
    throw new Error(`${file} has no valid privateKey`);
  }
  mkdirSync(dataDir, { recursive: true });
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  writeFileSync(file, JSON.stringify({ address, privateKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  log(`created the computer's earnings wallet ${address} (${file})`);
  return { address };
}
