/**
 * Agent-side client for the wallet-service. Scripted agents use exactly the same HTTP path as the
 * MCP server: they hold a token, never a key.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type {
  ApprovalWaitResponse,
  ConnectedService,
  EarningRequest,
  MeResponse,
  PayRequest,
  PayResponse,
  Receipt,
  ServiceRequest,
  ServiceRequestResponse,
  TransferRequest,
  TransferResponse,
} from "@allowance/shared";

export class WalletClient {
  constructor(
    public readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: "bad_json", message: text };
    }
    return { status: res.status, data: data as T };
  }

  async me(): Promise<MeResponse> {
    const r = await this.call<MeResponse>("GET", "/v1/me");
    if (r.status !== 200) throw new Error(`me failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async pay(req: PayRequest): Promise<PayResponse> {
    const r = await this.call<PayResponse>("POST", "/v1/pay", req);
    if (![200, 202, 403].includes(r.status)) throw new Error(`pay failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async settled(paymentId: string, settleResponse: unknown): Promise<Receipt> {
    const r = await this.call<{ receipt: Receipt }>("POST", `/v1/payments/${paymentId}/settled`, { settleResponse });
    if (r.status !== 200) throw new Error(`settled failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.receipt;
  }

  async transfer(req: TransferRequest): Promise<TransferResponse> {
    const r = await this.call<TransferResponse>("POST", "/v1/transfer", req);
    if (![200, 202, 403].includes(r.status)) throw new Error(`transfer failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async wait(approvalId: string, timeoutMs = 45_000): Promise<ApprovalWaitResponse> {
    const r = await this.call<ApprovalWaitResponse>("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=${timeoutMs}`);
    if (r.status !== 200) throw new Error(`wait failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async earning(req: EarningRequest): Promise<Receipt> {
    const r = await this.call<{ receipt: Receipt }>("POST", "/v1/earnings", req);
    if (r.status !== 200) throw new Error(`earning failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.receipt;
  }

  /** Connected services (the directory is implicit). */
  async services(): Promise<ConnectedService[]> {
    const r = await this.call<{ connected: ConnectedService[] }>("GET", "/v1/services");
    if (r.status !== 200) throw new Error(`services failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.connected ?? [];
  }

  /** Ask the owner to connect a service: 200 connected · 202 needs_approval. */
  async requestService(req: ServiceRequest): Promise<ServiceRequestResponse> {
    const r = await this.call<ServiceRequestResponse>("POST", "/v1/services/requests", req);
    if (r.status !== 200 && r.status !== 202) throw new Error(`service request failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async receipts(limit = 20): Promise<Receipt[]> {
    const r = await this.call<{ receipts: Receipt[] }>("GET", `/v1/receipts?limit=${limit}`);
    return r.data.receipts ?? [];
  }
}

export type PaidFetchResult =
  | { kind: "ok"; status: number; body: unknown; receipt?: Receipt; paid: boolean }
  | { kind: "needs_approval"; approvalId: string; paymentId: string; amount: string; message: string }
  | { kind: "blocked"; reason: string; message: string; frozen: boolean };

export interface PaidFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  description?: string;
  /** Called when approval is pending; return true to keep waiting (another 45 s), false to give up. */
  onWaiting?: (approvalId: string, amount: string) => Promise<boolean> | boolean;
}

/**
 * Fetch a URL; on 402 ask the wallet-service to pay, retry with PAYMENT-SIGNATURE, report settlement.
 * This mirrors the MCP server's fetch_url tool.
 */
export async function paidFetch(wallet: WalletClient, url: string, opts: PaidFetchOptions = {}): Promise<PaidFetchResult> {
  const method = opts.method ?? "GET";
  const init = (extra: Record<string, string> = {}): RequestInit => ({
    method,
    headers: { accept: "application/json", "content-type": "application/json", ...extra },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const first = await fetch(url, init());
  if (first.status !== 402) {
    return { kind: "ok", status: first.status, body: await parseBody(first), paid: false };
  }
  const prHeader = first.headers.get("PAYMENT-REQUIRED");
  if (!prHeader) throw new Error("402 without PAYMENT-REQUIRED header");
  const paymentRequired = decodePaymentRequiredHeader(prHeader);
  const pay = await wallet.pay({ paymentRequired: paymentRequired as never, url, description: opts.description, method, body: opts.body });

  if (pay.status === "blocked") return { kind: "blocked", reason: pay.reason, message: pay.message, frozen: pay.frozen };

  let paymentHeader: string;
  let paymentId: string;
  if (pay.status === "approved") {
    paymentHeader = pay.paymentHeader;
    paymentId = pay.paymentId;
  } else {
    // needs approval: long-poll until decided or the caller gives up
    for (;;) {
      const w = await wallet.wait(pay.approvalId, 45_000);
      if (w.status === "approved" && w.paymentHeader) {
        paymentHeader = w.paymentHeader;
        paymentId = w.paymentId;
        break;
      }
      if (w.status === "denied" || w.status === "expired") {
        return { kind: "blocked", reason: w.status, message: `Owner ${w.status} the payment of $${pay.amount}.`, frozen: false };
      }
      const keepWaiting = opts.onWaiting ? await opts.onWaiting(pay.approvalId, pay.amount) : false;
      if (!keepWaiting) {
        return { kind: "needs_approval", approvalId: pay.approvalId, paymentId: pay.paymentId, amount: pay.amount, message: pay.message };
      }
    }
  }

  const second = await fetch(url, init({ "PAYMENT-SIGNATURE": paymentHeader }));
  const body = await parseBody(second);
  const settleHeader = second.headers.get("PAYMENT-RESPONSE");
  let receipt: Receipt | undefined;
  if (settleHeader) {
    receipt = await wallet.settled(paymentId, decodePaymentResponseHeader(settleHeader));
  } else {
    receipt = await wallet.settled(paymentId, { success: false, errorReason: `http_${second.status}`, transaction: "", network: "eip155:84532" });
  }
  return { kind: "ok", status: second.status, body, receipt, paid: true };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
