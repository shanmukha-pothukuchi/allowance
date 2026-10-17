/**
 * Telegram owner bot. Pure SSE client of the wallet-service; optional.
 * No TELEGRAM_BOT_TOKEN → log one line and exit 0 so `npm run dev` keeps going.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "grammy";
import { loadConfig } from "@allowance/shared";
import type { WalletEvent } from "@allowance/shared";
import { helloText } from "./format.js";
import { Notifier } from "./notifier.js";
import { subscribeSse } from "./sse.js";

export { Notifier } from "./notifier.js";
export type { BotApi, CallbackContext } from "./notifier.js";
export * from "./format.js";
export { parseSseBlock, subscribeSse } from "./sse.js";

const LOG = "[notifier]";

const isMain = process.argv[1] && /notifier[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  void main();
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.telegramBotToken) {
    console.log(`${LOG} Telegram not configured; approvals via dashboard`);
    process.exit(0);
  }

  // ---- pairing state ------------------------------------------------------
  const pairingFile = join(config.dataDir, "notifier.json");
  let pairedChatId: string | undefined;
  try {
    if (existsSync(pairingFile)) pairedChatId = JSON.parse(readFileSync(pairingFile, "utf8")).chatId;
  } catch {
    /* ignore */
  }
  const chatId = () => config.telegramOwnerChatId ?? pairedChatId;

  const bot = new Bot(config.telegramBotToken);
  const notifier = new Notifier({ walletUrl: config.walletServiceUrl, api: bot.api, chatId, ownerApiKey: config.ownerApiKey });

  bot.command("start", async (ctx) => {
    const id = String(ctx.chat.id);
    if (!config.telegramOwnerChatId) {
      pairedChatId = id;
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(pairingFile, JSON.stringify({ chatId: id, pairedAt: new Date().toISOString() }, null, 2));
      console.log(`${LOG} paired with chat ${id}`);
    } else if (id !== config.telegramOwnerChatId) {
      await ctx.reply("This bot is already paired with its owner.");
      return;
    }
    await ctx.reply(helloText(), { parse_mode: "HTML" });
  });

  bot.on("callback_query:data", async (ctx) => {
    const owner = chatId();
    if (owner && String(ctx.chat?.id) !== owner) {
      await ctx.answerCallbackQuery({ text: "Not your wallet." });
      return;
    }
    const msg = ctx.callbackQuery.message;
    await notifier.handleCallback({
      id: ctx.callbackQuery.id,
      data: ctx.callbackQuery.data,
      chatId: msg?.chat.id,
      messageId: msg?.message_id,
      messageText: msg && "text" in msg ? htmlOf(msg) : undefined,
    });
  });

  bot.catch((err) => console.warn(`${LOG} bot error: ${err.message}`));

  // ---- wallet presence ----------------------------------------------------
  const report = async (connected: boolean) => {
    try {
      await fetch(`${config.walletServiceUrl}/v1/notifier/status`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.ownerApiKey ? { "x-owner-key": config.ownerApiKey } : {}) },
        body: JSON.stringify({ connected }),
      });
    } catch {
      /* wallet down; the SSE loop will retry */
    }
  };

  const abort = new AbortController();
  const shutdown = async () => {
    console.log(`${LOG} shutting down`);
    abort.abort();
    await report(false);
    await bot.stop().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // ---- Telegram long polling (retry forever; never crash) -----------------
  void (async () => {
    for (;;) {
      try {
        await bot.start({
          drop_pending_updates: true,
          onStart: (me) => console.log(`${LOG} Telegram connected as @${me.username}${chatId() ? "" : " (send /start to pair)"}`),
        });
        if (abort.signal.aborted) return;
      } catch (err) {
        console.warn(`${LOG} Telegram unreachable (${(err as Error).message}); retrying in 10s`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  })();

  // ---- wallet-service events ---------------------------------------------
  await subscribeSse({
    url: `${config.walletServiceUrl}/v1/events`,
    headers: config.ownerApiKey ? { "x-owner-key": config.ownerApiKey } : undefined,
    signal: abort.signal,
    onConnect: async () => {
      console.log(`${LOG} listening to ${config.walletServiceUrl}/v1/events`);
      await report(true);
    },
    onEvent: async (_type, data) => {
      let event: WalletEvent;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      await notifier.handleEvent(event);
    },
  });
}

/** Rebuild the HTML of a received message so we can append to it without losing links/bold. */
function htmlOf(msg: { text?: string; entities?: { type: string; offset: number; length: number; url?: string }[] }): string {
  const text = msg.text ?? "";
  const entities = (msg.entities ?? []).filter((e) => ["bold", "italic", "text_link"].includes(e.type));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (entities.length === 0) return esc(text);
  // Telegram offsets are UTF-16 code units, like JS string indices.
  const marks: { at: number; open: boolean; e: (typeof entities)[number] }[] = [];
  for (const e of entities) marks.push({ at: e.offset, open: true, e }, { at: e.offset + e.length, open: false, e });
  marks.sort((a, b) => a.at - b.at || (a.open === b.open ? 0 : a.open ? 1 : -1));
  let out = "";
  let pos = 0;
  for (const m of marks) {
    out += esc(text.slice(pos, m.at));
    pos = m.at;
    const tag = m.e.type === "bold" ? "b" : m.e.type === "italic" ? "i" : "a";
    out += m.open ? (tag === "a" ? `<a href="${esc(m.e.url ?? "")}">` : `<${tag}>`) : `</${tag}>`;
  }
  return out + esc(text.slice(pos));
}
