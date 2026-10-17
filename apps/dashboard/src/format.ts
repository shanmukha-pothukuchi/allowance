/**
 * Pure formatting helpers. Dollars only, never base units, friendly sentences.
 * Everything here is unit-tested in format.test.ts and must stay side-effect free.
 */
import type { Receipt, WalletEvent } from "./types";

/** "18.5" | 18.5 | "$18.50" -> integer cents (1850). Bad input -> 0. */
export function toCents(amount: string | number | undefined | null): number {
  if (amount === undefined || amount === null) return 0;
  const raw = String(amount).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === "" || raw === "-" || raw === ".") return 0;
  const negative = raw.startsWith("-");
  const [whole = "0", frac = ""] = raw.replace(/^-/, "").split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -cents : cents;
}

/** 1850 -> "18.50" (decimal dollar string, as used on the wire). */
export function fromCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** "18.5" -> "$18.50"; "-4.5" -> "-$4.50"; "1234.5" -> "$1,234.50". */
export function money(amount: string | number | undefined | null): string {
  const cents = toCents(amount);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

/** Signed money for feeds/receipts: "+$0.50", "-$0.05". */
export function signedMoney(amount: string | number, sign: "+" | "-"): string {
  const cents = Math.abs(toCents(amount));
  return `${sign}${money(fromCents(cents))}`;
}

/** Add two dollar strings exactly (via cents). */
export function addDollars(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}

/** "12 s ago", "3 min ago", "2 h ago", "yesterday", "Oct 3". */
export function relativeTime(iso: string | number | Date, now: number = Date.now()): string {
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Math.round((now - t) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff} s ago`;
  const min = Math.floor(diff / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** 0x1234567890abcdef... -> 0x1234…cdef */
export function shortHex(hex: string | undefined, head = 6, tail = 4): string {
  if (!hex) return "";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** Percentage of a cap used, clamped 0..100. Cap of 0 -> 0. */
export function pctOf(part: string | number, whole: string | number): number {
  const p = toCents(part);
  const w = toCents(whole);
  if (w <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((p / w) * 100)));
}

/** Short origin for display: "http://localhost:4021" -> "localhost:4021". */
export function shortOrigin(origin: string | undefined): string {
  if (!origin) return "";
  return origin.replace(/^https?:\/\//, "");
}

/** Who the money went to / came from, in words. */
export function counterpartyName(r: { counterparty?: Receipt["counterparty"]; description?: string } | undefined): string {
  if (!r) return "unknown";
  const cp = r.counterparty;
  if (cp?.name) return cp.name;
  if (r.description) return r.description;
  if (cp?.origin) return shortOrigin(cp.origin);
  if (cp?.address) return "an unknown address";
  return "unknown";
}

/** Capitalise the first letter; used so sentences always start upper case. */
function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The friendly sentence for an event. The wallet-service sends `message` already;
 * we use it when present and build one from the receipt/approval otherwise.
 * The mock adapter uses the same builder so both paths read identically.
 */
export function describeEvent(e: Pick<WalletEvent, "type" | "message" | "agentName" | "receipt" | "approval" | "reason" | "data">): string {
  if (e.message && e.message.trim()) return e.message.trim();
  const agent = e.agentName ?? "An agent";
  const r = e.receipt;
  const amt = r ? money(r.amount) : e.approval ? money(e.approval.amount) : "";
  const to = r ? counterpartyName(r) : e.approval ? counterpartyName(e.approval) : "unknown";
  switch (e.type) {
    case "payment.signed":
      return `${cap(agent)} is paying ${amt} to ${to}.`;
    case "payment.settled":
      return `Paid ${amt} to ${to}.`;
    case "payment.needs_approval":
      return `${cap(agent)} wants to pay ${amt} to ${to}. Needs your approval.`;
    case "payment.blocked":
      return e.reason === "insufficient_balance"
        ? `Blocked: ${agent} tried to pay ${amt} to ${to} but does not have enough.`
        : `Blocked: ${agent} tried to send ${amt} to ${to}. Agent frozen.`;
    case "approval.approved":
      return `Approved ${amt} to ${to}.`;
    case "approval.denied":
      return `Denied ${amt} to ${to}.`;
    case "transfer.sent":
      return `${cap(agent)} sent ${amt} to ${to}.`;
    case "earning.received":
      return `Earned ${amt} for ${r?.description ?? "work"}.`;
    case "topup":
      return `Added ${amt} to ${agent}.`;
    case "agent.frozen":
      return `${cap(agent)} is frozen.${e.reason ? ` ${e.reason}` : ""}`;
    case "agent.unfrozen":
      return `${cap(agent)} is unfrozen.`;
    case "agent.created":
      return `New agent ${agent}.`;
    case "policy.updated":
      return `Rules updated for ${agent}.`;
    case "token.revoked":
      return `A key for ${agent} was revoked.`;
    default:
      return cap(String(e.type).replace(".", " "));
  }
}

/** Receipt status in owner words. */
export function receiptStatusLabel(status: Receipt["status"]): string {
  switch (status) {
    case "pending_approval":
      return "waiting for you";
    case "signed":
      return "sending";
    case "settled":
      return "done";
    case "failed":
      return "failed";
    case "denied":
      return "denied";
    case "blocked":
      return "blocked";
  }
}
