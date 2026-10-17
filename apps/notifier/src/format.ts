/**
 * Telegram message formatting. Dollars only, friendly, no raw addresses
 * (the explorer link is the only place an address can be seen).
 * Messages use Telegram HTML parse mode; everything dynamic goes through esc().
 */
import { InlineKeyboard } from "grammy";
import type { Receipt, WalletEvent } from "@allowance/shared";

export interface TelegramMessage {
  text: string;
  keyboard?: InlineKeyboard;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(dollars: string | undefined): string {
  if (!dollars) return "$0.00";
  return dollars.startsWith("$") ? dollars : `$${dollars}`;
}

/** Who the money went to / came from, never a raw address. */
export function counterpartyLabel(r: Pick<Receipt, "counterparty" | "description"> | undefined): string {
  if (!r) return "someone";
  const cp = r.counterparty;
  if (cp?.name) return cp.name;
  if (cp?.origin) {
    try {
      return new URL(cp.origin).host;
    } catch {
      return cp.origin;
    }
  }
  if (r.description && !/^transfer$/i.test(r.description)) return r.description;
  return "an address";
}

function receiptLink(r: Receipt | undefined): string {
  if (!r?.explorerUrl) return "";
  return ` · <a href="${esc(r.explorerUrl)}">receipt</a>`;
}

export function approvalKeyboard(approvalId: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Approve", `apr:${approvalId}:approve`).text("❌ Deny", `apr:${approvalId}:deny`);
}

export function unfreezeKeyboard(agentId: string): InlineKeyboard {
  return new InlineKeyboard().text("🧊 Unfreeze", `agt:${agentId}:unfreeze`);
}

export function helloText(): string {
  return [
    "👋 <b>Allowance is connected.</b>",
    "",
    "I will send you:",
    "• 🔔 approval requests with Approve / Deny buttons",
    "• 🛑 alerts when a payment is blocked and an agent is frozen",
    "• 🧾 receipts for payments, transfers, earnings and top-ups",
    "",
    "Everything is enforced by the wallet, not the agent: even if an agent is tricked, it cannot spend outside your rules.",
  ].join("\n");
}

/** Map a wallet event to a Telegram message, or null if it is not owner-facing. */
export function formatEvent(e: WalletEvent): TelegramMessage | null {
  const r = e.receipt;
  const agent = esc(e.agentName ?? "An agent");
  switch (e.type) {
    case "payment.needs_approval": {
      const a = e.approval;
      if (!a) return null;
      const who = esc(counterpartyLabel(r ?? a));
      const what = a.description && a.description !== counterpartyLabel(r ?? a) ? `\n<i>${esc(a.description)}</i>` : "";
      return {
        text: `🔔 <b>Approval needed</b>\n${agent} wants to pay <b>${esc(money(a.amount))}</b> to ${who}.${what}`,
        keyboard: approvalKeyboard(a.id),
      };
    }
    case "payment.blocked": {
      const frozen = Boolean(e.data?.frozen);
      return {
        text: `🛑 <b>${agent}</b>: ${esc(e.message)}`,
        keyboard: frozen && e.agentId ? unfreezeKeyboard(e.agentId) : undefined,
      };
    }
    case "agent.frozen":
      return { text: `🧊 ${esc(e.message)}`, keyboard: e.agentId ? unfreezeKeyboard(e.agentId) : undefined };
    case "agent.unfrozen":
      return { text: `✅ ${esc(e.message)}` };
    case "payment.settled": {
      if (!r) return { text: `🧾 ${esc(e.message)}` };
      if (r.status === "failed") return { text: `⚠️ ${esc(e.message)}` };
      return { text: `💸 ${agent} paid <b>${esc(money(r.amount))}</b> to ${esc(counterpartyLabel(r))}${receiptLink(r)}` };
    }
    case "transfer.sent":
      return { text: `📤 ${agent} sent <b>${esc(money(r?.amount))}</b> to ${esc(counterpartyLabel(r))}${receiptLink(r)}` };
    case "earning.received":
      return { text: `💰 ${agent} earned <b>${esc(money(r?.amount))}</b> from ${esc(counterpartyLabel(r))}${receiptLink(r)}` };
    case "topup":
      return { text: `➕ Added <b>${esc(money(r?.amount))}</b> to ${agent}${receiptLink(r)}` };
    case "approval.approved":
    case "approval.denied":
      // Handled by editing the original approval message (see notifier.ts); nothing new is sent.
      return null;
    default:
      return null;
  }
}

/** Text appended to an approval message once it is decided. */
export function decisionSuffix(status: "approved" | "denied" | "expired", by?: string): string {
  const who = by && by !== "auto" ? ` via ${esc(by)}` : "";
  if (status === "approved") return `\n\n✅ <b>Approved</b>${who}`;
  if (status === "denied") return `\n\n❌ <b>Denied</b>${who}`;
  return `\n\n⌛ <b>Expired</b> (no answer within 10 minutes)`;
}
