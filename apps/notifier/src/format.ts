/**
 * Telegram message formatting. Dollars only, friendly, no raw addresses
 * (the explorer link is the only place an address can be seen).
 * Messages use Telegram HTML parse mode; everything dynamic goes through esc().
 */
import { InlineKeyboard } from "grammy";
import type { Approval, ConnectedService, Receipt, ServiceGrant, WalletEvent } from "@allowance/shared";

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
    "• 🔔 approval requests with Approve / Deny buttons (payments and new service connections)",
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
    case "service.requested":
      return e.approval ? serviceRequestMessage(e.approval) : null;
    case "service.connected":
    case "service.disconnected": {
      const s = e.data?.service as Partial<ConnectedService> | undefined;
      if (!s?.name) return { text: `🔌 ${esc(e.message)}` };
      const verb = e.type === "service.connected" ? "connected to" : "disconnected from";
      const shop = s.shopify ? ` (Shopify store <code>${esc(storefrontHost(s.shopify))}</code>)` : "";
      return { text: `🔌 ${esc(s.icon ?? "")}${s.icon ? " " : ""}<b>${esc(s.name)}</b>${shop} ${verb} ${agent}.` };
    }
    case "payment.blocked": {
      if (e.reason === "service_not_connected" || r?.reason === "service_not_connected") {
        // Soft block (no freeze): the agent was told to ask, so this is a heads-up, not an alarm.
        const name = /^(.+?) is not connected for /.exec(e.message)?.[1] ?? counterpartyLabel(r);
        return { text: `🔌 ${agent} tried to pay ${esc(name)}, which is not connected yet. It can ask you to connect it.` };
      }
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
    case "bank.posted":
      // The Capital One statement mirror (§16) is bookkeeping: quiet when it works.
      return null;
    case "bank.failed": {
      // One short line; the reason and the Retry button live on the dashboard.
      if (r?.kind === "topup") return { text: `⚠️ Couldn't move <b>${esc(money(r.amount))}</b> from Capital One to ${agent}. Retry it on the dashboard.` };
      return { text: `⚠️ Couldn't put ${agent}'s <b>${esc(money(r?.amount))}</b> (${esc(counterpartyLabel(r))}) on the Capital One statement. Retry it on the dashboard.` };
    }
    case "approval.approved":
    case "approval.denied":
      // Handled by editing the original approval message (see notifier.ts); nothing new is sent.
      return null;
    default:
      return null;
  }
}

/** "🔌 shopper wants to connect 🍕 Acme Pizza (Acme APIs). It could: • … Reason (from the agent): “…”" */
export function serviceRequestMessage(a: Approval): TelegramMessage | null {
  const s: Partial<ServiceGrant> | undefined = a.service;
  if (!s?.name) return null;
  if (s.shopify) return shopifyRequestMessage(a, s, s.shopify);
  const agent = esc(a.agentName || "An agent");
  const custom = s.source === "agent";
  const lines = [`🔌 <b>${agent}</b> wants to connect ${s.icon ? `${esc(s.icon)} ` : ""}<b>${esc(s.name)}</b>${!custom && s.provider ? ` (${esc(s.provider)})` : ""}.`];
  if (custom) lines.push(`⚠️ <b>Not in the directory</b> — proposed by ${agent}: <code>${esc(s.baseUrl)}</code>`);
  if (s.summary) lines.push(`<i>${esc(s.summary)}</i>`);
  const perms = (s.permissions ?? []).slice(0, 6);
  if (perms.length) lines.push("", "It could:", ...perms.map((p) => `• ${esc(p)}`));
  if (s.pricing) lines.push(`Pricing: ${esc(s.pricing)}`);
  if (a.reason) {
    const reason = a.reason.length > 300 ? `${a.reason.slice(0, 300)}…` : a.reason;
    lines.push("", `Reason (from the agent): “${esc(reason)}”`);
  }
  return { text: lines.join("\n"), keyboard: approvalKeyboard(a.id) };
}

/** The storefront domain people know: "https://www.allbirds.com" → "allbirds.com" (else the myshopify address). */
export function storefrontHost(shop: { domain: string; storefrontUrl?: string }): string {
  try {
    if (shop.storefrontUrl) return new URL(shop.storefrontUrl).host.replace(/^www\./, "");
  } catch {
    /* fall through */
  }
  return shop.domain;
}

/**
 * A Shopify store (ARCHITECTURE §15): say it is a Shopify store, show its storefront domain, the
 * per-order cap and how it is paid. A store the agent found is "added" (approving puts it in the directory).
 *   🛍️ shopper wants to add the Shopify store Allbirds.
 *   Store: allbirds.com (new: approving adds it to your directory)
 *   Per-order cap: $20.00 · pays with a single-use Allowance card (simulated)
 */
function shopifyRequestMessage(a: Approval, s: Partial<ServiceGrant>, shop: NonNullable<ServiceGrant["shopify"]>): TelegramMessage {
  const agent = esc(a.agentName || "An agent");
  const adding = s.source === "agent";
  const lines = [
    `🛍️ <b>${agent}</b> wants to ${adding ? "add" : "connect"} the Shopify store <b>${esc(s.name)}</b>.`,
    `Store: <code>${esc(storefrontHost(shop))}</code>${adding ? " (new: approving adds it to your directory)" : ""}`,
    `Per-order cap: <b>${esc(money(s.maxPrice ?? a.amount))}</b> · pays with a single-use Allowance card (simulated)`,
  ];
  const perms = (s.permissions ?? []).slice(0, 6);
  if (perms.length) lines.push("", "It could:", ...perms.map((p) => `• ${esc(p)}`));
  if (a.reason) {
    const reason = a.reason.length > 300 ? `${a.reason.slice(0, 300)}…` : a.reason;
    lines.push("", `Reason (from the agent): “${esc(reason)}”`);
  }
  return { text: lines.join("\n"), keyboard: approvalKeyboard(a.id) };
}

/** Text appended to an approval message once it is decided. */
export function decisionSuffix(status: "approved" | "denied" | "expired", by?: string): string {
  const who = by && by !== "auto" ? ` via ${esc(by)}` : "";
  if (status === "approved") return `\n\n✅ <b>Approved</b>${who}`;
  if (status === "denied") return `\n\n❌ <b>Denied</b>${who}`;
  return `\n\n⌛ <b>Expired</b> (no answer within 10 minutes)`;
}
