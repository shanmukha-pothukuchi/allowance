/**
 * Investing tools (docs/ARCHITECTURE.md §20): the paper brokerage and cash out.
 *
 * - `get_quotes`, `portfolio`: free reads. `portfolio` proves which wallet is asking with an
 *   attestation the agent's wallet signs (`POST /v1/attest`); the agent never sees a key.
 * - `buy_stock`: one x402 payment of the order amount, paid through the wallet exactly like
 *   fetch_url (policy, connected-service cap, approval threshold, daily cap). A buy that waits for the
 *   owner is parked in fetch_url's pending map, so check_approval finishes it.
 * - `sell_stock`: the brokerage pays the proceeds to the agent's wallet; the tool reports them as an
 *   earning, which the wallet checks against the ledger.
 * - `cash_out`: USDC from the agent's wallet back to the owner (`POST /v1/cashout`).
 *
 * Paper trading: every text says so, with the replay date, and "not investment advice".
 */
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { z } from "zod";
import { originOf, toBaseUnits, toDollars, type Receipt, type X402PaymentRequired, type X402SettleResponse } from "@allowance/shared";
import { receiptLine, txRef, usd } from "./format.js";
import { WalletApiError, WalletUnreachableError, type FetchLike, type WalletClient } from "./wallet-client.js";

/** What fetch_url parks while a payment waits for the owner (server.ts's PendingPayment). */
export interface ParkedPayment {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  paymentId: string;
  description: string;
}

export interface InvestToolOptions {
  wallet: WalletClient;
  walletServiceUrl: string;
  agentToken: string;
  fetch?: FetchLike;
  log?: (msg: string) => void;
  /** How long buy_stock waits for an owner decision (fetch_url's wait). */
  approvalWaitMs?: number;
  /** fetch_url's pending payments, so check_approval can finish an approved buy. */
  pending?: Map<string, ParkedPayment>;
  /** Last resort when the agent has no brokerage connection and the directory can't say. Default BROKERAGE_URL or http://localhost:4110. */
  brokerageUrl?: string;
}

export const BROKERAGE_ID = "brokerage";
export const BROKERAGE_NAME = "Brokerage (paper)";
const NOT_ADVICE = "not investment advice";
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

/** Brokerage answers, loosely typed (the brokerage owns the shapes; see apps/brokerage/src/app.ts). */
type Obj = Record<string, any>;

class BrokerageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: Obj,
  ) {
    super(message);
  }
}

export function registerInvestTools(server: McpServer, opts: InvestToolOptions): void {
  const wallet = opts.wallet;
  const doFetch: FetchLike = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? ((m: string) => console.error(`[mcp] ${m}`));
  const approvalWaitMs = opts.approvalWaitMs ?? 45_000;
  const pending = opts.pending ?? new Map<string, ParkedPayment>();
  const walletBase = opts.walletServiceUrl.replace(/\/+$/, "");

  // ---- helpers ------------------------------------------------------------------------------------

  const text = (s: string, structured?: Record<string, unknown>): CallToolResult =>
    structured ? { content: [{ type: "text", text: s }], structuredContent: structured } : { content: [{ type: "text", text: s }] };
  const errorResult = (s: string, structured?: Record<string, unknown>): CallToolResult => ({ ...text(s, structured), isError: true });

  async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WalletUnreachableError) return errorResult(err.message);
      if (err instanceof WalletApiError) {
        if (err.status === 401) return errorResult(`Wallet service rejected the agent token (${err.code}): ${err.message}`);
        return errorResult(`Wallet service error (HTTP ${err.status}, ${err.code}): ${err.message}`, { error: err.code });
      }
      if (err instanceof BrokerageError) return errorResult(err.message, { error: err.code, status: err.status });
      const msg = err instanceof Error ? err.message : String(err);
      log(`tool error: ${msg}`);
      return errorResult(`Error: ${msg}`);
    }
  }

  /** The agent's wallet endpoints this file needs beyond WalletClient (attest, cashout). */
  async function walletCall<T>(method: "POST", path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${walletBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.agentToken}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new WalletUnreachableError(walletBase, err);
    }
    const json = (await res.json().catch(() => ({}))) as Obj;
    if (res.ok) return json as T;
    throw new WalletApiError(res.status, json.error ?? `http_${res.status}`, json.message ?? `Wallet service returned HTTP ${res.status} for ${method} ${path}`, json.details);
  }

  /** The brokerage the agent uses: its connection, else the directory's listing, else the configured URL. */
  async function brokerage(): Promise<{ base: string; connected: boolean }> {
    try {
      const { connected } = await wallet.services();
      const svc = connected.find((s) => s.id === BROKERAGE_ID);
      if (svc) return { base: svc.baseUrl.replace(/\/+$/, ""), connected: true };
    } catch (err) {
      if (err instanceof WalletUnreachableError) throw err;
    }
    try {
      const entry = await wallet.directoryEntry(BROKERAGE_ID);
      if (entry?.baseUrl) return { base: entry.baseUrl.replace(/\/+$/, ""), connected: false };
    } catch {
      /* fall through */
    }
    const root = (opts.brokerageUrl ?? process.env.BROKERAGE_URL ?? "http://localhost:4110").replace(/\/+$/, "");
    return { base: `${root}/brokerage`, connected: false };
  }

  async function brokerageFetch(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(url, { ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new BrokerageError(503, "brokerage_unreachable", `The brokerage isn't answering at ${originOf(url) || url}. Nothing was charged or sold.`);
    }
  }

  async function readJson(res: Response): Promise<Obj> {
    return ((await res.json().catch(() => ({}))) ?? {}) as Obj;
  }

  /** A brokerage error answer as a BrokerageError (its own message; nothing was charged). */
  function brokerageError(status: number, body: Obj, what: string): BrokerageError {
    const message = typeof body.message === "string" && body.message ? body.message : `The brokerage answered HTTP ${status}.`;
    return new BrokerageError(status, typeof body.error === "string" ? body.error : `http_${status}`, `${what}: ${message}`, body);
  }

  /** `X-Allowance-Attestation` for the brokerage, signed by this agent's wallet. One per request. */
  async function attestation(base: string): Promise<Record<string, string>> {
    const a = await walletCall<{ header: string }>("POST", "/v1/attest", { audience: base, nonce: randomBytes(18).toString("base64url") });
    return { "x-allowance-attestation": a.header };
  }

  const honest = (b: Obj): string => {
    const label = typeof b.label === "string" ? b.label : "Paper trading";
    return `${label}${b.clockDate ? ` (replay date ${b.clockDate})` : ""} · ${NOT_ADVICE}.`;
  };
  const signedUsd = (d: unknown): string => {
    const s = String(d ?? "0");
    if (s.startsWith("-")) return `-${usd(s.slice(1))}`;
    return toBaseUnits(s || "0") === 0n ? usd("0") : `+${usd(s)}`;
  };
  const signedPct = (n: unknown): string => {
    const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
  };
  const tickerArg = (raw: string): string => raw.trim().toUpperCase();

  // ---- get_quotes -------------------------------------------------------------------------------------

  server.registerTool(
    "get_quotes",
    {
      title: "Get stock quotes (paper brokerage)",
      description:
        "Prices from the paper brokerage: real daily closes, replayed fast, so they move every few seconds. For each ticker: the price at the " +
        "brokerage's replay date, the 1-day change and the change since the replay started. Free. Paper trading, not investment advice.",
      inputSchema: {
        tickers: z.array(z.string()).min(1).max(20).describe('Stock symbols, e.g. ["COF", "JPM"]. Up to 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tickers }) =>
      guard(async () => {
        const list = [...new Set(tickers.map(tickerArg))];
        const bad = list.filter((t) => !TICKER_RE.test(t));
        if (bad.length) return errorResult(`Not a stock symbol: ${bad.join(", ")}. Use symbols like COF or JPM.`);
        const { base } = await brokerage();
        const res = await brokerageFetch(`${base}/quotes?tickers=${list.map(encodeURIComponent).join(",")}`);
        const body = await readJson(res);
        if (!res.ok) throw brokerageError(res.status, body, "No quotes");
        const lines = [`Quotes · replay date ${body.clockDate}`];
        for (const q of (body.quotes ?? []) as Obj[]) {
          lines.push(`${q.ticker} ${q.name} ${usd(q.price)} (${signedPct(q.changePct1d)} on the day, ${signedPct(q.changePctFromStart)} since ${body.startDate})`);
        }
        if (Array.isArray(body.unknown) && body.unknown.length) lines.push(`No prices for: ${body.unknown.join(", ")}.`);
        lines.push(honest(body));
        return text(lines.join("\n"), body);
      }),
  );

  // ---- buy_stock ----------------------------------------------------------------------------------------

  /** Retry the buy with the signed payment, report the settlement, describe the fill. */
  async function completeBuy(p: ParkedPayment, paymentHeader: string): Promise<CallToolResult> {
    const res = await brokerageFetch(p.url, { method: "POST", headers: { "PAYMENT-SIGNATURE": paymentHeader } });
    const body = await readJson(res);
    const settleHeader = res.headers.get("payment-response");
    let receipt: Receipt | undefined;
    if (settleHeader) {
      try {
        receipt = (await wallet.settled(p.paymentId, decodePaymentResponseHeader(settleHeader) as X402SettleResponse)).receipt;
      } catch (err) {
        log(`/settled failed for ${p.paymentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!res.ok) {
      const why = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
      return errorResult(`Not bought: ${why}`, { status: "failed", error: body.error, paymentId: p.paymentId });
    }
    const pos = (body.position ?? {}) as Obj;
    const lines = [
      `Bought ${body.shares} ${body.ticker} for ${usd(body.amount)} at ${usd(body.price)}. You now hold ${pos.shares ?? body.shares} ${body.ticker} (average cost ${usd(pos.avgCost ?? body.price)}).`,
      receipt ? receiptLine(receipt) : `Paid ${usd(body.amount)} to ${BROKERAGE_NAME}.`,
      honest(body),
    ];
    return text(lines.join("\n"), { status: "bought", order: body, receipt, paymentId: p.paymentId });
  }

  server.registerTool(
    "buy_stock",
    {
      title: "Buy a stock (paper brokerage)",
      description:
        "Buy fractional shares in the paper brokerage for a dollar amount, at the current replayed price. It is one USDC payment of the amount, " +
        "made through your wallet like fetch_url: your per-payment limit, the approval threshold and the daily cap apply, and big buys wait for " +
        "your owner. Needs Brokerage (paper) connected (request_service { service_id: \"brokerage\" }). Only buy when your owner asked you to or a " +
        "rule your owner set says so. Paper trading, not investment advice.",
      inputSchema: {
        ticker: z.string().describe("Stock symbol, e.g. COF."),
        amount: z.string().describe('Dollars to invest, e.g. "100.00" ($1.00 to $1000.00).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ticker: rawTicker, amount: rawAmount }) =>
      guard(async () => {
        const ticker = tickerArg(rawTicker);
        if (!TICKER_RE.test(ticker)) return errorResult(`"${rawTicker}" isn't a stock symbol. Use one like COF; get_quotes shows prices.`);
        let amount: string;
        try {
          amount = toDollars(toBaseUnits(rawAmount));
        } catch {
          return errorResult(`"${rawAmount}" isn't a dollar amount. Say how much to invest, like "100.00".`);
        }
        const { base } = await brokerage();
        const url = `${base}/orders/buy?ticker=${encodeURIComponent(ticker)}&amount=${encodeURIComponent(amount)}`;
        const first = await brokerageFetch(url, { method: "POST" });
        if (first.status !== 402) {
          const body = await readJson(first);
          if (first.ok) return errorResult(`The brokerage answered without asking for payment (HTTP ${first.status}); nothing was bought.`, body);
          throw brokerageError(first.status, body, "Not bought, nothing was charged");
        }
        await first.text().catch(() => undefined);
        const header = first.headers.get("payment-required");
        if (!header) return errorResult("The brokerage asked for payment without an x402 PAYMENT-REQUIRED header; nothing was bought.");
        const paymentRequired = decodePaymentRequiredHeader(header) as X402PaymentRequired;
        const description = `${BROKERAGE_NAME} · ${ticker}`;
        log(`buy ${ticker} for $${amount}: asking wallet-service`);
        const pay = await wallet.pay({ paymentRequired, url, description, method: "POST" });
        if (pay.status === "blocked") {
          if (pay.reason === "service_not_connected") {
            return errorResult(`${BROKERAGE_NAME} isn't connected yet. Ask your owner with request_service { service_id: "${BROKERAGE_ID}" }. Nothing was paid.`, {
              status: "blocked",
              reason: pay.reason,
              serviceId: BROKERAGE_ID,
            });
          }
          const frozen = pay.frozen ? " You are now frozen; your owner has been notified." : " Your owner has been notified.";
          return errorResult(`Blocked by wallet policy (${pay.reason}): ${pay.message}${frozen} Nothing was bought or paid. Don't retry; ask your owner if this trade was expected.`, {
            status: "blocked",
            reason: pay.reason,
            frozen: pay.frozen,
            amount,
          });
        }
        const entry: ParkedPayment = { url, method: "POST", paymentId: pay.paymentId, description };
        if (pay.status === "approved") return completeBuy(entry, pay.paymentHeader);
        pending.set(pay.approvalId, entry);
        log(`buy ${ticker} needs approval ${pay.approvalId}; waiting ${approvalWaitMs} ms`);
        const wait = await wallet.waitApproval(pay.approvalId, approvalWaitMs);
        if (wait.status === "approved" && wait.paymentHeader) {
          pending.delete(pay.approvalId);
          return completeBuy({ ...entry, paymentId: wait.paymentId || entry.paymentId }, wait.paymentHeader);
        }
        if (wait.status === "denied" || wait.status === "expired") {
          pending.delete(pay.approvalId);
          return text(
            wait.status === "denied"
              ? `Your owner denied buying ${usd(amount)} of ${ticker}. Nothing was paid. Don't retry unless they ask.`
              : `The approval to buy ${usd(amount)} of ${ticker} expired without a decision. Nothing was paid. Ask your owner before trying again.`,
            { status: wait.status, approvalId: pay.approvalId },
          );
        }
        return text(
          `Waiting for your owner to approve buying ${usd(amount)} of ${ticker}. Approval id ${pay.approvalId} — call check_approval to resume (the price is the one when it's paid). Tell the user their phone/dashboard has an approval request.`,
          { status: "pending", approvalId: pay.approvalId, amount, ticker },
        );
      }),
  );

  // ---- sell_stock ---------------------------------------------------------------------------------------

  server.registerTool(
    "sell_stock",
    {
      title: "Sell a stock (paper brokerage)",
      description:
        "Sell shares you hold in the paper brokerage at the current replayed price. The brokerage pays the proceeds in USDC to your wallet and " +
        "this records them as an earning, with the realized profit or loss. Leave out shares to sell the whole position. Free. Only sell when " +
        "your owner asked you to or a rule your owner set says so. Paper trading, not investment advice.",
      inputSchema: {
        ticker: z.string().describe("Stock symbol, e.g. COF."),
        shares: z.string().optional().describe('How many shares, e.g. "0.5". Leave out to sell all of them.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ticker: rawTicker, shares }) =>
      guard(async () => {
        const ticker = tickerArg(rawTicker);
        if (!TICKER_RE.test(ticker)) return errorResult(`"${rawTicker}" isn't a stock symbol. portfolio shows what you hold.`);
        const { base } = await brokerage();
        const res = await brokerageFetch(`${base}/orders/sell`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await attestation(base)) },
          body: JSON.stringify({ ticker, shares: shares?.trim() || "all" }),
        });
        const body = await readJson(res);
        if (!res.ok) throw brokerageError(res.status, body, "Nothing was sold");
        let receipt: Receipt | undefined;
        let note = "";
        try {
          receipt = (
            await wallet.earnings({
              amount: body.proceeds,
              txHash: body.payoutTx,
              description: `Sold ${body.shares} ${body.ticker}`,
              from: { address: body.from, origin: originOf(base), name: BROKERAGE_NAME },
            })
          ).receipt;
        } catch (err) {
          note = `\n(Note: the wallet didn't record this earning: ${err instanceof Error ? err.message : String(err)})`;
        }
        const left = body.position ? `You still hold ${body.position.shares} ${body.ticker}.` : `You hold no more ${body.ticker}.`;
        const lines = [
          `Sold ${body.shares} ${body.ticker} for ${usd(body.proceeds)} at ${usd(body.price)} · ${signedUsd(body.realizedPnl)} realized (${signedPct(body.realizedPct)} on a cost of ${usd(body.costBasis)}). ${left}`,
          receipt ? receiptLine(receipt) : `Paid to your wallet: tx ${body.payoutTx}.`,
          honest(body),
        ];
        return text(lines.join("\n") + note, { status: "sold", order: body, receipt });
      }),
  );

  // ---- portfolio ----------------------------------------------------------------------------------------

  server.registerTool(
    "portfolio",
    {
      title: "My portfolio (paper brokerage)",
      description:
        "Your positions in the paper brokerage: shares, price, value, cost and unrealized profit or loss per position, plus totals and realized " +
        "P/L from past sells. Your cash is your wallet balance (get_wallet). Free. Paper trading, not investment advice.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const { base } = await brokerage();
        const res = await brokerageFetch(`${base}/portfolio`, { headers: await attestation(base) });
        const body = await readJson(res);
        if (!res.ok) throw brokerageError(res.status, body, "Couldn't read your portfolio");
        const t = (body.totals ?? {}) as Obj;
        const positions = (body.positions ?? []) as Obj[];
        const lines = [`Portfolio · replay date ${body.clockDate}`];
        if (!positions.length) lines.push("No positions.");
        for (const p of positions) {
          lines.push(`${p.ticker} ${p.shares} shares at ${usd(p.price)} = ${usd(p.value)} (cost ${usd(p.costBasis)}, ${signedUsd(p.unrealizedPnl)}, ${signedPct(p.unrealizedPct)})`);
        }
        lines.push(
          `Total ${usd(t.value)} on ${usd(t.invested)} invested · unrealized ${signedUsd(t.unrealizedPnl)} (${signedPct(t.unrealizedPct)}) · realized ${signedUsd(t.realizedPnl)}.`,
          "Cash is your wallet balance (get_wallet).",
          honest(body),
        );
        return text(lines.join("\n"), body);
      }),
  );

  // ---- cash_out -----------------------------------------------------------------------------------------

  server.registerTool(
    "cash_out",
    {
      title: "Cash out to your owner",
      description:
        "Move USDC from your wallet back to your owner. Use it when your owner asks you to cash out, or when a rule your owner set says to. " +
        "Leave out amount to cash out everything. The money only goes to your owner, so the wallet allows it unless you are frozen.",
      inputSchema: {
        amount: z.string().optional().describe('Dollars, e.g. "25.00". Leave out to cash out your whole balance.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ amount }) =>
      guard(async () => {
        const want = amount?.trim() || "all";
        try {
          const r = await walletCall<{ receipt: Receipt; balance: string; vault: string }>("POST", "/v1/cashout", { amount: want });
          return text(`Cashed out ${usd(r.receipt.amount)} to your owner. Your balance is now ${usd(r.balance)}. Receipt: ${txRef(r.receipt.txHash, r.receipt.explorerUrl)}`, {
            status: "cashed_out",
            amount: r.receipt.amount,
            balance: r.balance,
            receipt: r.receipt,
          });
        } catch (err) {
          if (!(err instanceof WalletApiError)) throw err;
          const said: Record<string, string> = {
            frozen: "You're frozen, so only your owner can cash you out. Nothing moved.",
            nothing_to_cash_out: "Nothing to cash out: your balance is $0.00.",
            insufficient_balance: `${err.message} Nothing moved.`,
            cashout_in_progress: "A cash-out is already in progress; wait for it to finish.",
            invalid_request: `That isn't an amount the wallet can cash out (${err.message}).`,
          };
          return errorResult(said[err.code] ?? `The cash-out didn't go through: ${err.message}`, { status: "refused", error: err.code });
        }
      }),
  );
}
