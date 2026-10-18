/**
 * The brokerage wallet (docs/ARCHITECTURE.md §20.1): the x402 `payTo` for buys and the payer of sell
 * proceeds. Generated once into `DATA_DIR/brokerage-key.json` (mode 0600). The key is never logged;
 * only the address is.
 *
 * Paper trading pays profits out of this wallet. In mock mode it keeps itself funded on the mock
 * ledger (a float minted with the owner key, like the merchant's treasury); in chain mode it needs
 * Base Sepolia USDC (and gas) put there by hand, and a sell it can't cover is refused before anything
 * changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ownerHeaders, toBaseUnits, toDollars, type AppConfig } from "@allowance/shared";
import type { Settlement } from "@allowance/wallet";

export type BrokerageAccount = PrivateKeyAccount;

export function brokerageKeyPath(dataDir: string): string {
  return join(dataDir, "brokerage-key.json");
}

export function loadBrokerageAccount(dataDir: string, log: (msg: string) => void = (m) => console.log(`[brokerage] ${m}`)): BrokerageAccount {
  const file = brokerageKeyPath(dataDir);
  if (existsSync(file)) {
    try {
      const { privateKey } = JSON.parse(readFileSync(file, "utf8")) as { privateKey: `0x${string}` };
      const account = privateKeyToAccount(privateKey);
      log(`brokerage wallet ${account.address} (from ${file})`);
      return account;
    } catch (err) {
      // Never overwrite a key file we could not read: it holds the float that pays sells.
      throw new Error(`could not read ${file} (${(err as Error).message}); fix or remove it`);
    }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ address: account.address, privateKey, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  log(`generated the brokerage wallet ${account.address} (key stored in ${file})`);
  return account;
}

/** Mock mode keeps at least this much, topping up by FLOAT_TOPUP. */
export const FLOAT_MIN = toBaseUnits("100.00");
export const FLOAT_TOPUP = toBaseUnits("1000.00");

export class FloatError extends Error {}

/**
 * Make sure the wallet can pay `needUnits` (plus the minimum float). Mock mode mints the difference on
 * the mock ledger (owner key); chain mode only checks. Throws FloatError when it can't.
 */
export async function ensureFloat(
  config: Pick<AppConfig, "chainMode" | "facilitatorUrl" | "ownerApiKey">,
  settlement: Settlement,
  address: `0x${string}`,
  needUnits: bigint,
  log: (m: string) => void,
): Promise<void> {
  let balance: bigint;
  try {
    balance = await settlement.balanceOf(address);
  } catch (err) {
    throw new FloatError(`could not read the brokerage balance (${(err as Error).message})`);
  }
  if (balance >= needUnits + (config.chainMode === "mock" ? FLOAT_MIN : 0n)) return;
  if (config.chainMode !== "mock") throw new FloatError(`the brokerage wallet has $${toDollars(balance)} and needs $${toDollars(needUnits)}`);
  const mint = needUnits > balance ? needUnits - balance + FLOAT_TOPUP : FLOAT_TOPUP;
  let res: Response;
  try {
    res = await fetch(`${config.facilitatorUrl.replace(/\/+$/, "")}/admin/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(config) },
      body: JSON.stringify({ to: address, amount: toDollars(mint), memo: "brokerage float (paper trading)" }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new FloatError(`could not reach the ledger to fund the brokerage (${(err as Error).message})`);
  }
  if (!res.ok) throw new FloatError(`the ledger refused to fund the brokerage (HTTP ${res.status})`);
  log(`minted $${toDollars(mint)} of paper-trading float to the brokerage wallet (balance was $${toDollars(balance)})`);
}
