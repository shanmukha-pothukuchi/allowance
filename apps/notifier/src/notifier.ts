/**
 * Event → Telegram action mapping, independent of grammy's transport so it can be
 * unit-tested with a fake bot API. index.ts wires it to a real Bot and the SSE stream.
 */
import type { InlineKeyboard } from "grammy";
import type { Approval, WalletEvent } from "@allowance/shared";
import { decisionSuffix, esc, formatEvent } from "./format.js";

const LOG = "[notifier]";

/** The slice of the Telegram Bot API we use. grammy's `bot.api` satisfies it. */
export interface BotApi {
  sendMessage(
    chatId: string | number,
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard; disable_web_page_preview?: boolean; link_preview_options?: { is_disabled: boolean } },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard; link_preview_options?: { is_disabled: boolean } },
  ): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, other?: { text?: string; show_alert?: boolean }): Promise<unknown>;
}

export interface NotifierOptions {
  walletUrl: string;
  api: BotApi;
  /** Resolved lazily so pairing via /start can happen after startup. */
  chatId: () => string | undefined;
  ownerApiKey?: string;
  fetch?: typeof fetch;
}

export interface CallbackContext {
  id: string;
  data: string;
  chatId?: string | number;
  messageId?: number;
  /** Current message text (HTML), used when appending the decision. */
  messageText?: string;
}

interface SentApproval {
  chatId: string | number;
  messageId: number;
  text: string;
  decided: boolean;
}

export class Notifier {
  private readonly approvals = new Map<string, SentApproval>();
  private readonly alertedReceipts = new Set<string>();
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: NotifierOptions) {
    this.doFetch = opts.fetch ?? fetch;
  }

  // ---- wallet calls -------------------------------------------------------

  private async wallet(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.doFetch(`${this.opts.walletUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.opts.ownerApiKey ? { "x-owner-key": this.opts.ownerApiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text };
    }
    return { status: res.status, body: parsed };
  }

  // ---- events -------------------------------------------------------------

  async handleEvent(e: WalletEvent): Promise<void> {
    // Approval decided elsewhere (dashboard, expiry): edit our message instead of sending a new one.
    if (e.type === "approval.approved" || e.type === "approval.denied") {
      await this.markDecided(e.approval, e.reason);
      return;
    }
    // A policy block already alerted with an Unfreeze button; the paired agent.frozen is redundant.
    if (e.type === "payment.blocked" && e.receipt?.id) this.alertedReceipts.add(e.receipt.id);
    if (e.type === "agent.frozen") {
      const rid = e.data?.receiptId;
      if (typeof rid === "string" && this.alertedReceipts.has(rid)) return;
    }
    const msg = formatEvent(e);
    if (!msg) return;
    const chatId = this.opts.chatId();
    if (!chatId) {
      console.log(`${LOG} no owner chat yet (send /start to the bot); dropped ${e.type}`);
      return;
    }
    try {
      const sent = await this.opts.api.sendMessage(chatId, msg.text, {
        parse_mode: "HTML",
        reply_markup: msg.keyboard,
        link_preview_options: { is_disabled: true },
      });
      if (e.type === "payment.needs_approval" && e.approval) {
        this.approvals.set(e.approval.id, { chatId, messageId: sent.message_id, text: msg.text, decided: false });
        if (this.approvals.size > 200) this.approvals.delete(this.approvals.keys().next().value!);
      }
    } catch (err) {
      console.warn(`${LOG} Telegram send failed for ${e.type}: ${(err as Error).message}`);
    }
    if (this.alertedReceipts.size > 500) this.alertedReceipts.clear();
  }

  private async markDecided(approval: Approval | undefined, reason?: string): Promise<void> {
    if (!approval) return;
    const sent = this.approvals.get(approval.id);
    if (!sent || sent.decided) return;
    sent.decided = true;
    const status = approval.status === "approved" ? "approved" : approval.status === "expired" || reason === "expired" ? "expired" : "denied";
    const text = sent.text + decisionSuffix(status, approval.decidedBy);
    try {
      await this.opts.api.editMessageText(sent.chatId, sent.messageId, text, { parse_mode: "HTML" });
    } catch (err) {
      console.warn(`${LOG} could not edit approval message: ${(err as Error).message}`);
    }
  }

  // ---- button taps --------------------------------------------------------

  async handleCallback(cb: CallbackContext): Promise<void> {
    const [kind, id, action] = cb.data.split(":");
    try {
      if (kind === "apr" && (action === "approve" || action === "deny")) {
        await this.decideApproval(cb, id, action);
      } else if (kind === "agt" && action === "unfreeze") {
        await this.unfreeze(cb, id);
      } else {
        await this.opts.api.answerCallbackQuery(cb.id, { text: "Unknown button" });
      }
    } catch (err) {
      console.warn(`${LOG} callback ${cb.data} failed: ${(err as Error).message}`);
      await this.opts.api.answerCallbackQuery(cb.id, { text: "Something went wrong; try the dashboard.", show_alert: true }).catch(() => {});
    }
  }

  private async decideApproval(cb: CallbackContext, approvalId: string, action: "approve" | "deny"): Promise<void> {
    const sent = this.approvals.get(approvalId);
    const { status, body } = await this.wallet("POST", `/v1/approvals/${approvalId}/${action}`, { by: "telegram" });
    if (status !== 200) {
      const message = typeof body.message === "string" ? body.message : `Wallet said ${status}`;
      await this.opts.api.answerCallbackQuery(cb.id, { text: message, show_alert: true });
      if (status === 409 && sent && !sent.decided) {
        // Already decided elsewhere; the approval event will have edited it, but make sure.
        sent.decided = true;
        await this.editSafely(cb, sent, sent.text + `\n\n<i>${esc(message)}</i>`);
      }
      return;
    }
    const approval = body.approval as Approval;
    const outcome = approval.status === "approved" ? "approved" : "denied";
    await this.opts.api.answerCallbackQuery(cb.id, { text: outcome === "approved" ? "Approved ✅" : "Denied ❌" });
    const baseText = sent?.text ?? cb.messageText ?? `Approval ${approvalId}`;
    if (sent) sent.decided = true;
    let suffix = decisionSuffix(outcome, "telegram");
    if (action === "approve" && approval.status === "denied") {
      suffix = `\n\n⚠️ <b>Could not approve</b>: the wallet re-checked the rules and refused.`;
    }
    await this.editSafely(cb, sent, baseText + suffix);
  }

  private async unfreeze(cb: CallbackContext, agentId: string): Promise<void> {
    const { status, body } = await this.wallet("POST", `/v1/agents/${agentId}/unfreeze`);
    if (status !== 200) {
      const message = typeof body.message === "string" ? body.message : `Wallet said ${status}`;
      await this.opts.api.answerCallbackQuery(cb.id, { text: message, show_alert: true });
      return;
    }
    const agent = body.agent as { name?: string } | undefined;
    await this.opts.api.answerCallbackQuery(cb.id, { text: `${agent?.name ?? "Agent"} unfrozen` });
    const baseText = cb.messageText ?? "🧊 Agent frozen";
    await this.editSafely(cb, undefined, `${baseText}\n\n✅ <b>Unfrozen</b> via telegram`);
  }

  private async editSafely(cb: CallbackContext, sent: SentApproval | undefined, text: string): Promise<void> {
    const chatId = sent?.chatId ?? cb.chatId;
    const messageId = sent?.messageId ?? cb.messageId;
    if (chatId === undefined || messageId === undefined) return;
    try {
      await this.opts.api.editMessageText(chatId, messageId, text, { parse_mode: "HTML" });
    } catch (err) {
      console.warn(`${LOG} could not edit message: ${(err as Error).message}`);
    }
  }
}
