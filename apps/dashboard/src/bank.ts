/**
 * Capital One behind Allowance (§16, Nessie sandbox): pure helpers for the dashboard's bank lines,
 * receipt markers and statements. No React, unit-tested in bank.test.ts.
 */
import { fromCents, money, toCents } from "./format";
import type { BankStatementEntry, BankSummary, Receipt, ReceiptBank, SummaryResponse, WalletEvent } from "./types";

/** The summary's bank block (§16.4): present only when the wallet has a Nessie key. */
export type SummaryBank = NonNullable<SummaryResponse["bank"]>;

export const PROVIDER = "Capital One";
/** The note every balance carries somewhere (a title, a footnote). */
export const SANDBOX_NOTE = "Capital One's Nessie sandbox: real API calls, sandbox accounts and money.";

/** "1234" → "••1234" (the wallet's `last4` is alphanumeric, up to 8 characters); "••1234" stays; nothing → "". */
export function masked(last4: string | undefined | null): string {
  const tail = String(last4 ?? "").replace(/[^0-9A-Za-z]/g, "").slice(-8);
  return tail ? `••${tail}` : "";
}

export const isLinked = (b: SummaryResponse["bank"] | BankSummary | null | undefined): boolean => !!b?.linked;

/** "Capital One Checking ••1234 · $4,982.00" (top bar). */
export function checkingLine(b: Pick<SummaryBank, "checkingLast4" | "checkingBalance">): string {
  const acct = masked(b.checkingLast4);
  return `${PROVIDER} Checking${acct ? ` ${acct}` : ""}${b.checkingBalance !== undefined ? ` · ${money(b.checkingBalance)}` : ""}`;
}

/** "From Capital One Checking ••1234 · $4,982.00 available" (add money). */
export function sourceLine(b: Pick<SummaryBank, "checkingLast4" | "checkingBalance">): string {
  const acct = masked(b.checkingLast4);
  return `From ${PROVIDER} Checking${acct ? ` ${acct}` : ""}${b.checkingBalance !== undefined ? ` · ${money(b.checkingBalance)} available` : ""}`;
}

/** "Moved $20.00 from Checking to shopper's allowance account" (add money, done). */
export const movedLine = (amount: string, agentName: string) => `Moved ${money(amount)} from Checking to ${agentName}'s allowance account`;

/** True when the checking balance we know of can't cover this amount (the wallet still decides). */
export function short(b: SummaryResponse["bank"] | null | undefined, amount: string): boolean {
  return !!b?.linked && b.checkingBalance !== undefined && toCents(b.checkingBalance) < toCents(amount);
}

/** The bank's two top-up errors (§16.3), in the wallet's words, with our own words as a fallback. */
export function topupBankError(code: string | undefined, message: string | undefined, ctx: { checking?: string; amount?: string } = {}): string | null {
  const m = (message ?? "").trim();
  const said = m && m !== code ? m : "";
  if (code === "bank_insufficient_funds") {
    if (said) return said;
    return ctx.checking !== undefined && ctx.amount !== undefined
      ? `Your Capital One checking has ${money(ctx.checking)}, not enough to add ${money(ctx.amount)}.`
      : "Your Capital One checking doesn't have enough to add that.";
  }
  if (code === "bank_unavailable") return said || "Capital One didn't confirm the transfer, so nothing was added.";
  return null;
}

// ---------------------------------------------------------------------------- receipt markers

export type MarkerTone = "posted" | "queued" | "failed" | "stopped";
export interface BankMarker {
  tone: MarkerTone;
  text: string;
  /** "Not on statement": the owner can ask the wallet to post it again. */
  retry?: boolean;
  /** Hover detail: the account, when it posted, why it failed. */
  title?: string;
}

/**
 * The small line under a receipt (§16.5). Only receipts that reached the bank carry `bank`; a blocked
 * or denied payment never does, and says so when a bank is linked. Nothing at all without a bank.
 */
export function bankMarker(r: Pick<Receipt, "status" | "bank"> | undefined | null, linked: boolean): BankMarker | null {
  if (!r) return null;
  const b = r.bank;
  if (b) {
    const acct = masked(b.account);
    if (b.status === "posted") return { tone: "posted", text: "On Capital One statement", title: `Posted to Capital One ${acct || "allowance account"} (Nessie sandbox)${b.ref ? ` · ${b.ref}` : ""}` };
    if (b.status === "queued") return { tone: "queued", text: "Posting to Capital One…", title: `Queued for Capital One ${acct || "allowance account"} (Nessie sandbox)` };
    if (b.status === "failed") return { tone: "failed", text: "Not on statement", retry: true, title: b.error ? `Capital One: ${b.error}` : "Capital One didn't take this entry" };
  }
  if (linked && (r.status === "blocked" || r.status === "denied")) return { tone: "stopped", text: "Stopped before it reached your bank" };
  return null;
}

/**
 * What the bank has to do with a receipt, in words (§16.3). The agent pays (and earns) in USDC;
 * the Capital One entry is a copy posted to its allowance account's statement. Top-ups are the
 * one flow where the bank is the source: dollars leave checking, then the wallet credits the same
 * amount in test USDC. `line` is the visible text in detail views, `title` the tooltip everywhere.
 */
export function bankNote(r: Pick<Receipt, "kind" | "agentName" | "bank">, checkingLast4?: string): { line: string; title: string } | null {
  const b = r.bank;
  if (!b) return null;
  if (r.kind === "topup") {
    const from = `From ${PROVIDER} Checking${masked(checkingLast4) ? ` ${masked(checkingLast4)}` : ""}`;
    const state = b.status === "queued" ? " · moving…" : b.status === "failed" ? " · not on statement" : "";
    return { line: `${from}${state}`, title: `${from}: the dollars leave checking and the wallet credits the same amount in test USDC (Nessie sandbox)` };
  }
  if (r.kind === "cashout") {
    // §20.2: the USDC goes back to the owner; the bank moves the same dollars into checking.
    const to = `To ${PROVIDER} Checking${masked(checkingLast4) ? ` ${masked(checkingLast4)}` : ""}`;
    const state = b.status === "queued" ? " · moving…" : b.status === "failed" ? " · not on statement" : "";
    return { line: `${to}${state}`, title: `${to}: the USDC went back to you and Capital One moved the same dollars into checking (Nessie sandbox)` };
  }
  const how = r.kind === "earn" ? "Earned in USDC" : "Paid in USDC";
  const acct = masked(b.account);
  const stmt = `${PROVIDER} statement${acct ? ` ${acct}` : ""}`;
  const whose = `${r.agentName}'s ${stmt}`;
  if (b.status === "posted") return { line: `${how} · on ${stmt}`, title: `${how} · also on ${whose} (Nessie sandbox)` };
  if (b.status === "queued") return { line: `${how} · posting to ${stmt}`, title: `${how} · a copy is posting to ${whose} (Nessie sandbox)` };
  return { line: `${how} · not on ${stmt}`, title: `${how} · the copy didn't reach ${whose}${b.error ? `: ${b.error}` : ""}` };
}

/** Feed rows that carry a marker: one per payment (the settled row, not its "is paying" or approval rows). */
const MARKED_EVENTS = new Set(["payment.settled", "earning.received", "topup", "transfer.sent", "payment.blocked", "approval.denied", "cashout"]);
export function feedMarker(e: Pick<WalletEvent, "type" | "receipt">, linked: boolean): BankMarker | null {
  if (!MARKED_EVENTS.has(e.type) || !e.receipt) return null;
  return bankMarker(e.receipt, linked);
}

export const isBankEvent = (type: string) => type === "bank.posted" || type === "bank.failed";

/**
 * The receipt's new `bank` from a `bank.posted` / `bank.failed` event: the receipt it carries, else
 * built from `data` (`{ receiptId, ref, kind, account }` / `{ receiptId, kind, error }`).
 */
export function bankFromEvent(e: Pick<WalletEvent, "type" | "receipt" | "data">): { receiptId: string; bank: ReceiptBank } | null {
  const data = (e.data ?? {}) as { receiptId?: string; ref?: string; account?: string; error?: string };
  const receiptId = e.receipt?.id ?? data.receiptId;
  if (!receiptId || !isBankEvent(e.type)) return null;
  const want = e.type === "bank.posted" ? "posted" : "failed";
  if (e.receipt?.bank?.status === want) return { receiptId, bank: e.receipt.bank };
  const account = data.account ?? e.receipt?.bank?.account ?? "";
  return want === "posted"
    ? { receiptId, bank: { status: "posted", account, ...(data.ref ? { ref: data.ref } : {}) } }
    : { receiptId, bank: { status: "failed", account, ...(data.error ? { error: data.error } : {}) } };
}

/** Copy `bank` onto every copy of that receipt in the feed (events keep the receipt as it was when sent). */
export function patchReceiptBank<T extends { receipt?: Receipt }>(items: T[], receiptId: string, bank: ReceiptBank): T[] {
  let changed = false;
  const out = items.map((x) => {
    if (x.receipt?.id !== receiptId) return x;
    changed = true;
    return { ...x, receipt: { ...x.receipt, bank } };
  });
  return changed ? out : items;
}

/**
 * The feed as the owner should see it after a snapshot: bank events folded into the receipts they
 * update (newest wins, then the receipts list, which is current) and dropped as rows of their own.
 */
export function foldBankEvents(newestFirst: WalletEvent[], receipts: Receipt[] = []): WalletEvent[] {
  const latest = new Map<string, ReceiptBank>();
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const b = bankFromEvent(newestFirst[i]);
    if (b) latest.set(b.receiptId, b.bank);
  }
  for (const r of receipts) if (r.bank) latest.set(r.id, r.bank);
  return newestFirst
    .filter((e) => !isBankEvent(e.type))
    .map((e) => {
      const b = e.receipt?.id ? latest.get(e.receipt.id) : undefined;
      return b && e.receipt!.bank !== b ? { ...e, receipt: { ...e.receipt!, bank: b } } : e;
    });
}

// ---------------------------------------------------------------------------- statements

/** Money in to this account (+) or out of it (−). */
export const entryIn = (e: Pick<BankStatementEntry, "kind">) => e.kind === "transfer_in" || e.kind === "deposit";

/** "+$20.00" / "−$0.05". */
export function entryAmount(e: Pick<BankStatementEntry, "kind" | "amount">): string {
  const m = money(fromCents(Math.abs(toCents(e.amount))));
  return entryIn(e) ? `+${m}` : `−${m}`;
}

const STRIP = / · paid in USDC$/;
/** What the owner reads first: the merchant, else the description without our suffix. */
export function entryTitle(e: Pick<BankStatementEntry, "kind" | "merchant" | "description">): string {
  if (e.merchant && e.merchant.trim()) return e.merchant.trim();
  const d = (e.description ?? "").replace(STRIP, "").trim();
  // §16.3: a top-up whose USDC credit failed is reversed, agent account → checking.
  const reversed = d.match(/^Allowance top-up reversed · (.+)$/);
  if (reversed) return e.kind === "transfer_out" ? "Top-up reversed to Checking" : `Reversed from ${reversed[1]}'s allowance account`;
  if (e.kind === "transfer_in" && /^Allowance top-up/i.test(d)) return "Top-up from Checking";
  if (e.kind === "transfer_out") {
    const who = d.match(/^Allowance top-up · (.+)$/);
    if (who) return `To ${who[1]}'s allowance account`;
  }
  return d.replace(/^Earned · /, "") || (entryIn(e) ? "Money in" : "Money out");
}

export const KIND_LABEL: Record<BankStatementEntry["kind"], string> = {
  purchase: "Purchase",
  deposit: "Deposit",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

/** Nessie's own status as it says it ("pending" → "Pending"); unknown or missing → "". */
export function nessieStatus(status: string | undefined): string {
  const s = String(status ?? "").trim();
  return s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : "";
}

/** Settled at Nessie (executed / completed) vs still moving (pending) vs nothing happened (cancelled). */
export function statusTone(status: string | undefined): "done" | "pending" | "void" | "other" {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed" || s === "completed" || s === "posted") return "done";
  if (s === "pending") return "pending";
  if (s === "cancelled" || s === "canceled" || s === "failed") return "void";
  return "other";
}

/** "2026-10-18" (a bank date, no time zone) → "Today" / "Yesterday" / "Oct 16". */
export function statementDate(date: string, now: number = Date.now()): string {
  const m = String(date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(date ?? "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** "2 posting · 1 not on statement", or null when the queue is empty. */
export function queueLine(q: BankSummary["queue"] | undefined): string | null {
  if (!q) return null;
  const parts = [q.pending > 0 ? `${q.pending} posting` : "", q.failed > 0 ? `${q.failed} not on statement` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** This agent's allowance account, if the bank has opened one. */
export function accountFor(bank: BankSummary | null | undefined, agentId: string) {
  return bank?.accounts.find((a) => a.agentId === agentId);
}
