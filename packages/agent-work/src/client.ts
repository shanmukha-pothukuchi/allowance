import type { AgentWorkDoc, Address, BountyDoc, ClaimResponse, PayoutResponse } from "@allowance/shared";
import { PAYOUT_RESPONSE_HEADER, decodePayoutResponseHeader } from "./header.js";

export class AgentWorkClientError extends Error {
  readonly status: number;
  /** Spec error code, e.g. "bounty_full", or "http_error" when the body was not JSON. */
  readonly code: string;
  readonly details?: unknown;
  readonly body?: unknown;
  constructor(status: number, code: string, message: string, body?: unknown, details?: unknown) {
    super(message);
    this.name = "AgentWorkClientError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.details = details;
  }
}

export interface ClientOptions {
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Abort after this many ms. Default 30000. */
  timeoutMs?: number;
}

const WELL_KNOWN = "/.well-known/agent-work";

async function readJson(res: globalThis.Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function throwFor(res: globalThis.Response): Promise<never> {
  const body = await readJson(res);
  const b = (body && typeof body === "object" ? body : {}) as { error?: string; message?: string; details?: unknown };
  const code = typeof b.error === "string" ? b.error : "http_error";
  const message = typeof b.message === "string" ? b.message : `HTTP ${res.status}`;
  throw new AgentWorkClientError(res.status, code, `${code}: ${message}`, body, b.details);
}

function withTimeout(opts: ClientOptions): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/** Resolve a site URL (or a direct URL to the document) to the well-known document URL. */
export function wellKnownUrl(siteUrl: string): string {
  const u = new URL(siteUrl);
  if (u.pathname.replace(/\/+$/, "").endsWith(WELL_KNOWN)) return u.toString();
  return new URL(WELL_KNOWN, u).toString();
}

/** GET /.well-known/agent-work as JSON. Accepts a site origin or the document URL itself. */
export async function discover(siteUrl: string, opts: ClientOptions = {}): Promise<AgentWorkDoc> {
  const f = opts.fetch ?? fetch;
  const { signal, done } = withTimeout(opts);
  try {
    const res = await f(wellKnownUrl(siteUrl), { headers: { Accept: "application/json" }, signal });
    if (!res.ok) await throwFor(res);
    const doc = (await readJson(res)) as AgentWorkDoc;
    if (!doc || typeof doc !== "object" || doc.protocol !== "agent-work" || !Array.isArray(doc.bounties)) {
      throw new AgentWorkClientError(res.status, "invalid_document", "Response is not an agent-work document.", doc);
    }
    return doc;
  } finally {
    done();
  }
}

/** POST {bounty.claimUrl}. Resolves on 201; throws AgentWorkClientError otherwise. */
export async function claim(
  bounty: Pick<BountyDoc, "claimUrl">,
  walletAddress: Address,
  agentName?: string,
  opts: ClientOptions = {},
): Promise<ClaimResponse> {
  const f = opts.fetch ?? fetch;
  const { signal, done } = withTimeout(opts);
  try {
    const res = await f(bounty.claimUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(agentName ? { walletAddress, agentName } : { walletAddress }),
      signal,
    });
    if (res.status !== 201) await throwFor(res);
    return (await readJson(res)) as ClaimResponse;
  } finally {
    done();
  }
}

/**
 * POST {claim.submitUrl}. Resolves with the PayoutResponse on 200 (also checks the
 * PAYOUT-RESPONSE header); throws AgentWorkClientError on 404/410/422/502.
 *
 * Both `submit(claim, result)` and `submit(claim, walletAddress, result)` are accepted; the
 * claim already carries its walletAddress.
 */
export async function submit(claim: ClaimResponse, result: unknown, opts?: ClientOptions): Promise<PayoutResponse>;
export async function submit(
  claim: ClaimResponse,
  walletAddress: Address,
  result: unknown,
  opts?: ClientOptions,
): Promise<PayoutResponse>;
export async function submit(claim: ClaimResponse, a: unknown, b?: unknown, c?: ClientOptions): Promise<PayoutResponse> {
  // Three-arg form: (claim, walletAddress, result). Two-arg form: (claim, result[, opts]).
  const threeArg = arguments.length >= 3 && typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !isClientOptions(b);
  const walletAddress = threeArg ? (a as Address) : claim.walletAddress;
  const result = threeArg ? b : a;
  const opts: ClientOptions = (threeArg ? c : (b as ClientOptions | undefined)) ?? {};
  const f = opts.fetch ?? fetch;
  const { signal, done } = withTimeout(opts);
  try {
    const res = await f(claim.submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ claimId: claim.claimId, walletAddress, result }),
      signal,
    });
    if (res.status !== 200) await throwFor(res);
    const body = (await readJson(res)) as PayoutResponse | undefined;
    const header = res.headers.get(PAYOUT_RESPONSE_HEADER);
    const fromHeader = header ? safeDecode(header) : undefined;
    const payout = body && typeof body === "object" && body.status === "paid" ? body : fromHeader;
    if (!payout) throw new AgentWorkClientError(200, "invalid_response", "200 without a PayoutResponse body or header.", body);
    return payout;
  } finally {
    done();
  }
}

function isClientOptions(v: unknown): v is ClientOptions {
  return !!v && typeof v === "object" && !Array.isArray(v) && ("fetch" in (v as object) || "timeoutMs" in (v as object)) && Object.keys(v as object).every((k) => k === "fetch" || k === "timeoutMs");
}

function safeDecode(header: string): PayoutResponse | undefined {
  try {
    return decodePayoutResponseHeader(header);
  } catch {
    return undefined;
  }
}
