import { formatUsd, toBaseUnits, type Receipt } from "@allowance/shared";

/** "18.5" -> "$18.50". Falls back to "$<raw>" if the string is not a clean amount. */
export function usd(dollars: string | number | undefined | null): string {
  if (dollars === undefined || dollars === null || dollars === "") return "$0.00";
  try {
    return formatUsd(toBaseUnits(dollars));
  } catch {
    return `$${dollars}`;
  }
}

/** "0x12ab34…cd34" style. */
export function shortHash(hash: string | undefined | null): string {
  if (!hash) return "(no tx hash yet)";
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function shortAddress(addr: string | undefined | null): string {
  return shortHash(addr);
}

/** "tx 0x12ab…cd34 (http://localhost:4030/tx/0x…)" */
export function txRef(txHash?: string, explorerUrl?: string): string {
  if (!txHash) return "no tx hash yet";
  return explorerUrl ? `tx ${shortHash(txHash)} (${explorerUrl})` : `tx ${shortHash(txHash)}`;
}

/** Name to show for the other side of a receipt. */
export function counterpartyName(r: Receipt): string {
  return r.counterparty?.name || r.description || r.counterparty?.origin || shortAddress(r.counterparty?.address);
}

/**
 * One-line receipt. Examples:
 *   Paid $0.05 to Acme Weather. Receipt: tx 0x12ab…cd34 (link)
 *   Earned $0.50 for Bounty: API reliability check. Receipt: tx 0x… (link)
 *   Sent $1.00 to 0xabcd…1234. Receipt: tx 0x… (link)
 */
export function receiptLine(r: Receipt): string {
  const amount = usd(r.amount);
  const ref = txRef(r.txHash, r.explorerUrl);
  switch (r.kind) {
    case "earn":
      return `Earned ${amount} for ${r.description || "work"}. Receipt: ${ref}`;
    case "transfer":
      return `Sent ${amount} to ${shortAddress(r.counterparty?.address)}${r.description && r.description !== "Transfer" ? ` (${r.description})` : ""}. Receipt: ${ref}`;
    case "topup":
      return `Top-up of ${amount}. Receipt: ${ref}`;
    case "spend":
    default:
      return `Paid ${amount} to ${counterpartyName(r)}. Receipt: ${ref}`;
  }
}

/** Short status-aware line for list_receipts. */
export function receiptListLine(r: Receipt): string {
  const when = r.settledAt ?? r.createdAt;
  const amount = usd(r.amount);
  const who = r.kind === "earn" ? r.description : counterpartyName(r);
  const failed = r.status === "blocked" || r.status === "denied" || r.status === "failed";
  const verb =
    r.kind === "earn" ? "earned" : r.kind === "transfer" ? (failed ? "tried to send" : "sent") : r.kind === "topup" ? "top-up" : failed ? "tried to pay" : "paid";
  const status = r.status === "settled" ? "" : ` [${r.status}${r.reason ? `: ${r.reason}` : ""}]`;
  const ref = r.txHash ? ` — ${txRef(r.txHash, r.explorerUrl)}` : "";
  return `${when}  ${verb} ${amount}  ${who}${status}${ref}`;
}

/** Pretty-print a response body for Claude; truncates big bodies. */
export function formatBody(text: string, contentType: string | null, maxChars = 20_000): string {
  let out = text;
  if (contentType && /json/i.test(contentType)) {
    try {
      out = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* leave as-is */
    }
  }
  if (out.length > maxChars) {
    return `${out.slice(0, maxChars)}\n\n… [truncated: ${out.length - maxChars} more characters not shown]`;
  }
  return out;
}

/** Fields every service shape (manifest, grant, connection) has. */
export interface ServiceLike {
  id: string;
  name: string;
  icon?: string;
  summary?: string;
  pricing?: string;
  /** Shopify stores only (ARCHITECTURE §15). */
  shopify?: { domain: string; mode: string };
}

/** "- 🌤️ Acme Weather (acme-weather): Current weather for any city · $0.05 per call" (+ " · Shopify store x.myshopify.com, agent checkout") */
export function serviceLine(s: ServiceLike): string {
  const summary = (s.summary ?? "").replace(/\s+/g, " ").trim();
  return `- ${s.icon ? `${s.icon} ` : ""}${s.name} (${s.id})${summary ? `: ${summary}` : ""}${s.pricing ? ` · ${s.pricing}` : ""}${s.shopify ? ` · ${shopifyTag(s.shopify)}` : ""}`;
}

/** "Shopify store crypto-app-test.myshopify.com, agent checkout" / "…, browse only" */
export function shopifyTag(shop: { domain: string; mode: string }): string {
  return `Shopify store ${shop.domain}, ${shop.mode === "agent_checkout" ? "agent checkout" : "browse only"}`;
}

/** What the mode means for the agent, one sentence. */
export function shopifyModeLine(shop: { mode: string }, maxPrice?: string): string {
  return shop.mode === "agent_checkout"
    ? `Agent checkout: you pay orders in USDC from your wallet${maxPrice ? ` (up to ${usd(maxPrice)} per order)` : ""} and the store gets a real, paid order.`
    : "Browse only: you can search and build a cart, but you cannot pay here. Give the user the cart's checkout link to finish at Shopify.";
}
