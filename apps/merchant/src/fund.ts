/**
 * Mock-mode self-funding: the company wallet mints itself $1000 on the mock facilitator if
 * its balance is under $100, so bounty payouts never bounce during the demo. Retries for
 * ~15 s while the facilitator boots; logs and gives up quietly if it never appears.
 */
import { ownerHeaders, type AppConfig, toBaseUnits, toDollars } from "@allowance/shared";

const MIN_BALANCE = toBaseUnits("100.00");
const MINT_AMOUNT = "1000.00";

export async function ensureFunded(
  config: Pick<AppConfig, "chainMode" | "facilitatorUrl" | "ownerApiKey">,
  address: string,
  opts: { attempts?: number; delayMs?: number; log?: (msg: string) => void } = {},
): Promise<{ minted: boolean; balance?: string }> {
  if (config.chainMode !== "mock") return { minted: false };
  const attempts = opts.attempts ?? 15;
  const delayMs = opts.delayMs ?? 1000;
  const log = opts.log ?? ((m: string) => console.log(`[merchant] ${m}`));
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${config.facilitatorUrl}/balance/${address}`);
      if (!res.ok) throw new Error(`balance ${res.status}`);
      const { balanceBaseUnits } = (await res.json()) as { balanceBaseUnits: string };
      if (BigInt(balanceBaseUnits) >= MIN_BALANCE) {
        log(`company wallet balance $${toDollars(BigInt(balanceBaseUnits))}, no mint needed`);
        return { minted: false, balance: toDollars(BigInt(balanceBaseUnits)) };
      }
      const mint = await fetch(`${config.facilitatorUrl}/admin/mint`, {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders(config) },
        body: JSON.stringify({ to: address, amount: MINT_AMOUNT, memo: "company treasury seed" }),
      });
      if (!mint.ok) throw new Error(`mint ${mint.status}`);
      const { balance } = (await mint.json()) as { balance: string };
      log(`minted $${MINT_AMOUNT} to company wallet ${address} (balance now $${balance})`);
      return { minted: true, balance };
    } catch (err) {
      lastError = (err as Error).message;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  log(`facilitator at ${config.facilitatorUrl} not reachable (${lastError}); skipping self-mint, payouts may fail`);
  return { minted: false };
}
