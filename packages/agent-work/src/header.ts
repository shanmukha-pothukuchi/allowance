import type { PayoutResponse } from "@allowance/shared";

/** Name of the header that mirrors the 200 body on submit (like x402's PAYMENT-RESPONSE). */
export const PAYOUT_RESPONSE_HEADER = "PAYOUT-RESPONSE";

/** PayoutResponse -> base64(JSON). */
export function encodePayoutResponseHeader(payout: PayoutResponse): string {
  return Buffer.from(JSON.stringify(payout), "utf8").toString("base64");
}

/** base64(JSON) -> PayoutResponse. Throws on malformed input. */
export function decodePayoutResponseHeader(header: string): PayoutResponse {
  const json = Buffer.from(header.trim(), "base64").toString("utf8");
  const parsed = JSON.parse(json) as PayoutResponse;
  if (!parsed || parsed.status !== "paid" || typeof parsed.txHash !== "string") {
    throw new Error("Malformed PAYOUT-RESPONSE header");
  }
  return parsed;
}
