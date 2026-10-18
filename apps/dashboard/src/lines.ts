/**
 * One Linear-style line per thing that happened (docs/ui-rules.md, rules 1, 2 and 5): an actor, a
 * verb, an object, and at most a short muted tail. Amounts are not part of the sentence (they sit
 * right-aligned in their own column), and status is a small mark, never a coloured sentence. Also
 * the approval card's title and meta line, said once. Pure, unit-tested in lines.test.ts.
 */
import { masked } from "./bank";
import { cashoutLine, tradeLine, tradeOf } from "./invest";
import { counterpartyName, fromCents, isCustomGrant, isServiceApproval, isShopifyGrant, isSoftBlock, money, serviceOfEvent, toCents } from "./format";
import type { Approval, Receipt, ServiceGrant, WalletEvent } from "./types";

/** A small status mark beside a line: only for states that need the owner's eye. */
export interface LineStatus {
  text: string;
  tone: "danger" | "warn" | "neutral";
}

/** "**actor** verb **object**tail". Every part but `verb` is optional. */
export interface Line {
  actor?: string;
  verb: string;
  object?: string;
  /** Muted, right after the object: " · not connected". */
  tail?: string;
  status?: LineStatus;
}

/** "just now", "12s ago", "3m ago", "5h ago", "yesterday", "3d ago", "Oct 3". */
export function shortAgo(iso: string | number | Date, now: number = Date.now()): string {
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The plain text of a line, for titles, tests and screen readers. */
export function lineText(l: Line): string {
  return [l.actor, l.verb, l.object].filter(Boolean).join(" ") + (l.tail ?? "");
}

const BOUNTY = /^Bounty:\s*/i;

/** Who was paid: its name, else its site; a bare transfer to an address nobody named is "an unknown address". */
function payee(r: Pick<Receipt, "kind" | "counterparty" | "description">): string {
  if (r.counterparty?.name) return r.counterparty.name;
  if (r.counterparty?.origin) return counterpartyName(r);
  if (r.kind === "transfer" || /^transfer$/i.test((r.description ?? "").trim())) return "an unknown address";
  return counterpartyName(r);
}

function earnLine(agent: string, r: Pick<Receipt, "description" | "counterparty"> | undefined): Line {
  const d = (r?.description ?? "").trim();
  if (BOUNTY.test(d)) return { actor: agent, verb: "earned a bounty for", object: d.replace(BOUNTY, "") };
  return { actor: agent, verb: "earned from", object: r ? counterpartyName(r) : "work" };
}

/** Top-ups are the one flow where the bank is the source (§16.3): "… from Capital One Checking ••7688". */
function topupLine(agent: string, r: Pick<Receipt, "description" | "bank"> | undefined, checkingLast4?: string): Line {
  const fromBank = r?.bank ? ` from Capital One Checking${masked(checkingLast4) ? ` ${masked(checkingLast4)}` : ""}` : "";
  if (/^starting balance$/i.test((r?.description ?? "").trim())) return { actor: agent, verb: "was funded", tail: fromBank };
  return { actor: agent, verb: "got a top-up", tail: fromBank };
}

const BLOCKED: LineStatus = { text: "Blocked", tone: "danger" };
const STOPPED: LineStatus = { text: "Blocked", tone: "neutral" };

/** Why a soft block happened, in two or three words. */
const SOFT_REASON: Record<string, string> = {
  insufficient_balance: "not enough money",
  service_not_connected: "not connected",
  service_cap: "over the service's cap",
  frozen: "agent is frozen",
  unsupported_requirements: "unsupported payment",
};

const decidedOn = (a: Pick<Approval, "decidedBy"> | undefined) => (a?.decidedBy === "telegram" ? " on Telegram" : "");

/** " · Pizza order" when the payment's description says more than who was paid. */
function whatTail(description: string | undefined, to: string): string {
  const d = (description ?? "").trim();
  return d && d.toLowerCase() !== to.toLowerCase() ? ` · ${d}` : "";
}

/**
 * The feed line for a wallet event. Known types get their own words; anything else falls back to
 * the wallet's message. `pending` marks an ask that is still waiting on the owner.
 */
export function activityLine(
  e: Pick<WalletEvent, "type" | "agentName" | "receipt" | "approval" | "reason" | "data"> & { message?: string },
  opts: { pending?: boolean; checkingLast4?: string } = {},
): Line {
  const agent = e.agentName ?? "An agent";
  const r = e.receipt;
  const to = r ? payee(r) : e.approval ? counterpartyName(e.approval) : "unknown";
  const svc = serviceOfEvent(e);
  const svcName = svc?.name ?? to;
  const service = isServiceApproval(e.approval);
  const pending: LineStatus | undefined = opts.pending ? { text: "Pending", tone: "warn" } : undefined;
  // §20: a buy is a payment to the brokerage, a sell an earning from it.
  const trade = e.type === "payment.settled" || e.type === "payment.signed" || e.type === "earning.received" ? tradeOf(r) : null;
  if (trade) return tradeLine(agent, trade, { pending: e.type === "payment.signed" });
  switch (e.type) {
    case "cashout":
      return cashoutLine(agent, r?.amount ?? (e.data as { amount?: string } | undefined)?.amount, opts.checkingLast4);
    case "payment.settled":
      return { actor: agent, verb: "paid", object: to, tail: whatTail(r?.description, to) };
    case "payment.signed":
      return { actor: agent, verb: "is paying", object: to, tail: whatTail(r?.description, to) };
    case "transfer.sent":
      return { actor: agent, verb: "sent money to", object: to };
    case "payment.needs_approval":
      return { actor: agent, verb: "asked to pay", object: to, tail: whatTail(r?.description ?? e.approval?.description, to), status: pending };
    case "earning.received":
      return earnLine(agent, r);
    case "topup":
      return topupLine(agent, r, opts.checkingLast4);
    case "payment.blocked": {
      const reason = e.reason ?? r?.reason;
      if (!isSoftBlock(e)) return { actor: agent, verb: r?.kind === "transfer" || to === "an unknown address" ? "tried to send money to" : "tried to pay", object: to, tail: " · agent frozen", status: BLOCKED };
      if (reason === "service_not_connected") return { actor: agent, verb: "tried to pay", object: svc?.name ?? to, tail: " · not connected", status: STOPPED };
      return { actor: agent, verb: "tried to pay", object: reason === "service_cap" ? (svc?.name ?? to) : to, tail: reason && SOFT_REASON[reason] ? ` · ${SOFT_REASON[reason]}` : "", status: STOPPED };
    }
    case "service.requested":
      if (isShopifyGrant(svc) && svc?.source === "agent") return { actor: agent, verb: "asked to add", object: svcName, status: pending };
      if (isCustomGrant(svc)) return { actor: agent, verb: "proposed", object: svcName, status: pending };
      return { actor: agent, verb: "asked to connect", object: svcName, status: pending };
    case "service.connected":
      return { actor: agent, verb: "can now use", object: svcName };
    case "service.disconnected":
      return { actor: agent, verb: "can no longer use", object: svcName };
    case "approval.approved":
      return service ? { actor: agent, verb: "was approved to connect", object: svcName, tail: decidedOn(e.approval) } : { actor: agent, verb: "was approved to pay", object: to, tail: decidedOn(e.approval) };
    case "approval.denied":
      if (e.reason === "expired" || e.approval?.status === "expired") {
        return service ? { actor: agent, verb: "asked to connect", object: svcName, tail: " · expired" } : { actor: agent, verb: "asked to pay", object: to, tail: " · expired" };
      }
      return service ? { actor: agent, verb: "was denied", object: svcName, tail: decidedOn(e.approval) } : { actor: agent, verb: "was denied paying", object: to, tail: decidedOn(e.approval) };
    case "agent.frozen":
      return { actor: agent, verb: "was frozen", tail: e.reason ? ` · ${e.reason.replace(/\.$/, "")}` : "" };
    case "agent.unfrozen":
      return { actor: agent, verb: "was unfrozen" };
    case "agent.created":
      return { actor: agent, verb: "was created" };
    case "policy.updated":
      return { actor: agent, verb: "got new limits" };
    case "token.revoked":
      return { actor: agent, verb: "had a key revoked" };
    default:
      return { verb: (e.message ?? "").trim() || String(e.type).replace(".", " ") };
  }
}

/** The Receipts tab line: same words as the feed, the status as a mark. */
export function receiptLine(r: Receipt, opts: { checkingLast4?: string } = {}): Line {
  if (r.kind === "cashout") return cashoutLine(r.agentName, r.amount, opts.checkingLast4);
  const trade = r.status === "settled" || r.status === "signed" ? tradeOf(r) : null;
  if (trade) return tradeLine(r.agentName, trade, { pending: r.status === "signed" });
  if (r.kind === "earn") return earnLine(r.agentName, r);
  if (r.kind === "topup") return topupLine(r.agentName, r, opts.checkingLast4);
  const to = payee(r);
  const transfer = r.kind === "transfer";
  const tail = transfer ? "" : whatTail(r.description, to);
  switch (r.status) {
    case "settled":
      return { actor: r.agentName, verb: transfer ? "sent money to" : "paid", object: to, tail };
    case "signed":
      return { actor: r.agentName, verb: transfer ? "is sending money to" : "is paying", object: to, tail };
    case "pending_approval":
      return { actor: r.agentName, verb: "asked to pay", object: to, tail, status: { text: "Pending", tone: "warn" } };
    case "blocked":
      return { actor: r.agentName, verb: transfer ? "tried to send money to" : "tried to pay", object: to, tail, status: { text: "Blocked", tone: "danger" } };
    case "denied":
      return { actor: r.agentName, verb: "asked to pay", object: to, tail, status: { text: "Denied", tone: "neutral" } };
    case "failed":
      return { actor: r.agentName, verb: "tried to pay", object: to, tail, status: { text: "Failed", tone: "danger" } };
  }
}

// ---------------------------------------------------------------------------- approval card

/** "Connect Quantcomm Flood Research?" for every kind of service (stores too), "Pay $18.50 to Acme Pizza?". */
export function approvalTitle(a: Pick<Approval, "kind" | "service" | "amount" | "counterparty" | "description">): string {
  const s = isServiceApproval(a) ? a.service : undefined;
  if (s) return `Connect ${s.name}?`;
  return `Pay ${money(a.amount)} to ${counterpartyName(a)}?`;
}

/** The cap, said once: "up to $0.10 per request" (or per order, per quote…), or "free". */
export function capMeta(maxPrice: string | undefined, unit = "request"): string {
  return toCents(maxPrice) > 0 ? `up to ${money(maxPrice)} per ${unit}` : "free";
}

/**
 * What one payment buys, from the pricing line: "order" for "$18.50 per order", "quote" for
 * "$0.15 per quote". Several prices ("per flood check · per analyst view") or none: "request".
 */
export function capUnit(pricing: string | undefined, store = false): string {
  if (store) return "order";
  const units = [...new Set([...(pricing ?? "").matchAll(/\bper ([a-z]+(?: [a-z]+)?)/gi)].map((m) => m[1].toLowerCase()))];
  return units.length === 1 ? units[0] : "request";
}

/**
 * What a connected agent can do, in one muted line. Permissions that state a price ("Pay up to
 * $0.10 per request") repeat the cap, which the card already says, so they are left out.
 */
export function permissionsLine(permissions: string[] | undefined): string {
  return (permissions ?? [])
    .map((p) => p.trim())
    .filter((p) => p && !/\$\s?\d/.test(p))
    .join(" · ");
}

/** Pricing worth showing next to the cap: only when it says something the cap doesn't. */
export function pricingBeyondCap(s: Pick<ServiceGrant, "pricing" | "maxPrice">): string {
  const p = (s.pricing ?? "").trim();
  if (!p) return "";
  const cap = toCents(s.maxPrice);
  const prices = [...p.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => toCents(m[1]));
  // "$0.05 per request" with a $0.05 cap says the same thing twice.
  if (prices.length === 1 && prices[0] === cap) return "";
  if (prices.length === 0 && cap <= 0 && /^free/i.test(p)) return "";
  return p;
}

// ---------------------------------------------------------------------------- amounts

export type AmountTone = "in" | "out" | "pending" | "void";
export interface AmountCell {
  text: string;
  tone: AmountTone;
}

const plain = (amount: string) => money(fromCents(Math.abs(toCents(amount))));
const cell = (amount: string, tone: AmountTone): AmountCell => ({
  text: tone === "in" ? `+${plain(amount)}` : tone === "out" ? `−${plain(amount)}` : plain(amount),
  tone,
});

/** A feed row's amount: signed like a statement, plain while it waits, void when refused. Null: no money moved. */
export function eventAmount(e: Pick<WalletEvent, "type" | "receipt" | "approval">): AmountCell | null {
  if (e.type === "approval.approved" || e.type === "approval.denied") return null;
  const raw = e.receipt?.amount ?? (e.type === "payment.needs_approval" ? e.approval?.amount : undefined);
  if (raw === undefined) return null;
  // The cash-out line names its amount; the column doesn't repeat it (rule 1).
  if (e.type === "cashout") return null;
  if (e.type === "payment.blocked") return cell(raw, "void");
  if (e.type === "earning.received" || e.type === "topup") return cell(raw, "in");
  if (e.type === "payment.needs_approval") return cell(raw, "pending");
  return cell(raw, "out");
}

/** A receipt's amount, by the same rules. */
export function receiptAmount(r: Pick<Receipt, "kind" | "status" | "amount">): AmountCell {
  if (r.status === "blocked" || r.status === "denied" || r.status === "failed") return cell(r.amount, "void");
  if (r.kind === "earn" || r.kind === "topup") return cell(r.amount, "in");
  if (r.status === "pending_approval") return cell(r.amount, "pending");
  return cell(r.amount, "out");
}

/** A receipt row's amount column: a settled cash-out says its amount in the sentence, so none (rule 1). */
export function receiptColumn(r: Pick<Receipt, "kind" | "status" | "amount">): AmountCell | null {
  return r.kind === "cashout" && r.status === "settled" ? null : receiptAmount(r);
}
