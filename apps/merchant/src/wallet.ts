/**
 * Company wallet: the account that receives x402 payments and pays bounties.
 * `MERCHANT_PRIVATE_KEY` wins; otherwise a key is generated once and stored in
 * `DATA_DIR/merchant-key.json` (mode 0600). The key is never logged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { AppConfig } from "@allowance/shared";

export type CompanyAccount = PrivateKeyAccount;

export function loadCompanyAccount(config: Pick<AppConfig, "dataDir" | "merchantPrivateKey">): CompanyAccount {
  if (config.merchantPrivateKey) {
    const account = privateKeyToAccount(config.merchantPrivateKey);
    console.log(`[merchant] company wallet ${account.address} (from MERCHANT_PRIVATE_KEY)`);
    return account;
  }
  const file = join(config.dataDir, "merchant-key.json");
  if (existsSync(file)) {
    try {
      const { privateKey } = JSON.parse(readFileSync(file, "utf8")) as { privateKey: `0x${string}` };
      const account = privateKeyToAccount(privateKey);
      console.log(`[merchant] company wallet ${account.address} (from ${file})`);
      return account;
    } catch (err) {
      console.warn(`[merchant] could not read ${file} (${(err as Error).message}); generating a new key`);
    }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ address: account.address, privateKey, createdAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  console.log(`[merchant] generated company wallet ${account.address} (key stored in ${file})`);
  return account;
}
