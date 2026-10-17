/**
 * USDC money helpers. USDC has 6 decimals. Internally we always use bigint base units
 * ("micro-dollars"); the API and UI use decimal dollar strings ("18.50").
 */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** "18.5" | "18.50" | 18.5 | "$18.50" -> 18500000n. Throws on bad input. */
export function toBaseUnits(dollars: string | number): bigint {
  const raw = String(dollars).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === "" || raw === "." || raw === "-") {
    throw new Error(`Invalid dollar amount: ${JSON.stringify(dollars)}`);
  }
  const negative = raw.startsWith("-");
  const [whole = "0", frac = ""] = raw.replace(/^-/, "").split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`Too many decimals (max ${USDC_DECIMALS}): ${raw}`);
  }
  const units = BigInt(whole || "0") * SCALE + BigInt((frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS));
  return negative ? -units : units;
}

/** 18500000n -> "18.50" (always at least 2 decimals, trailing zeros beyond 2 trimmed). */
export function toDollars(units: bigint | string): string {
  const u = typeof units === "string" ? BigInt(units) : units;
  const negative = u < 0n;
  const abs = negative ? -u : u;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0");
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** 18500000n -> "$18.50" */
export function formatUsd(units: bigint | string): string {
  const d = toDollars(units);
  return d.startsWith("-") ? `-$${d.slice(1)}` : `$${d}`;
}

/** Parse a base-unit string from JSON ("18500000") safely into bigint. */
export function parseBaseUnits(s: string | number | bigint): bigint {
  if (typeof s === "bigint") return s;
  if (!/^\d+$/.test(String(s))) throw new Error(`Invalid base units: ${s}`);
  return BigInt(s);
}

/** "18.5" | 18.5 | "$18.50" -> "$18.50". Dollar-string input (the API wire format). */
export function formatDollars(dollars: string | number): string {
  return formatUsd(toBaseUnits(dollars));
}
