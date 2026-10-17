import type {
  ApprovalWaitResponse,
  EarningRequest,
  MeResponse,
  PayRequest,
  PayResponse,
  Receipt,
  TransferRequest,
  TransferResponse,
  X402SettleResponse,
} from "@allowance/shared";

export type FetchLike = typeof fetch;

/** The wallet-service could not be reached at all (not running / wrong URL). */
export class WalletUnreachableError extends Error {
  constructor(public readonly baseUrl: string, cause?: unknown) {
    super(`Wallet service is not running at ${baseUrl}. Start it with \`npm run dev\`.`);
    this.name = "WalletUnreachableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** The wallet-service answered with an error body (4xx/5xx other than the status-carrying 202/403). */
export class WalletApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WalletApiError";
  }
}

export interface WalletClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

/**
 * Typed client for the wallet-service agent endpoints (ARCHITECTURE §6).
 * Holds the bearer token privately; never puts it in error messages or return values.
 */
export class WalletClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(opts: WalletClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  me(): Promise<MeResponse> {
    return this.#request<MeResponse>("GET", "/v1/me");
  }

  /** HTTP 200 approved / 202 needs_approval / 403 blocked all carry a PayResponse body. */
  pay(req: PayRequest): Promise<PayResponse> {
    return this.#request<PayResponse>("POST", "/v1/pay", req, [200, 202, 403]);
  }

  settled(paymentId: string, settleResponse: X402SettleResponse): Promise<{ receipt: Receipt }> {
    return this.#request<{ receipt: Receipt }>("POST", `/v1/payments/${encodeURIComponent(paymentId)}/settled`, {
      settleResponse,
    });
  }

  transfer(req: TransferRequest): Promise<TransferResponse> {
    return this.#request<TransferResponse>("POST", "/v1/transfer", req, [200, 202, 403]);
  }

  waitApproval(approvalId: string, timeoutMs: number): Promise<ApprovalWaitResponse> {
    return this.#request<ApprovalWaitResponse>(
      "GET",
      `/v1/approvals/${encodeURIComponent(approvalId)}/wait?timeoutMs=${Math.max(0, Math.floor(timeoutMs))}`,
      undefined,
      undefined,
      // allow the long-poll to run a bit past the server-side timeout
      timeoutMs + 10_000,
    );
  }

  earnings(req: EarningRequest): Promise<{ receipt: Receipt }> {
    return this.#request<{ receipt: Receipt }>("POST", "/v1/earnings", req);
  }

  async receipts(limit = 20): Promise<Receipt[]> {
    const r = await this.#request<{ receipts: Receipt[] }>("GET", `/v1/receipts?limit=${Math.floor(limit)}`);
    return r.receipts ?? [];
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201],
    timeoutMs = 20_000,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WalletUnreachableError(this.baseUrl, err);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (okStatuses.includes(res.status)) return json as T;
    const e = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new WalletApiError(
      res.status,
      e.error ?? `http_${res.status}`,
      e.message ?? `Wallet service returned HTTP ${res.status} for ${method} ${path}`,
      e.details,
    );
  }
}
