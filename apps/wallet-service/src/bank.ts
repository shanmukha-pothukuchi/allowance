/**
 * Capital One behind Allowance (docs/ARCHITECTURE.md §16), on Capital One's Nessie sandbox.
 *
 * The owner has one customer and a checking account; every agent gets its own allowance account.
 * Nessie as verified live (2026-10-18): bodies are validated strictly (extra fields are a 400),
 * amounts are integers, a transfer sits on ONE account (no payee), and `balance` never moves. So:
 * - every amount Allowance posts, and every opening balance, is integer **cents**;
 * - a balance is computed here: opening balance + deposits − withdrawals − purchases − transfers on
 *   that account (cancelled records don't count);
 * - a top-up is two records: a transfer on checking (the bank's confirmation) and a deposit on the
 *   agent's account. A reversal is the mirror image.
 * Settled payments become purchases at a merchant named after the counterparty, earnings become
 * deposits; both go through a queue persisted in DATA_DIR/bank.json, one job at a time.
 *
 * Only this module talks to Nessie and only it holds the key. The key goes in `?key=` and is
 * scrubbed from every error message, so it never reaches a log line, a response or an event.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatUsd, localDayKey, newId, nowIso, toBaseUnits, toDollars } from "@allowance/shared";
import type {
  AppConfig,
  BankStatementEntry,
  BankStatementResponse,
  BankSummary,
  EventType,
  MeResponse,
  Receipt,
  ReceiptBank,
  SummaryResponse,
  WalletEvent,
} from "@allowance/shared";
import type { Store } from "./store.js";

const LOG = "[wallet-service] bank:";
const PROVIDER = "Capital One" as const;
const SANDBOX = "Nessie" as const;
const CHECKING_NICKNAME = "Allowance owner checking";
/** §16.2: the owner's customer record, also used as every merchant's address. */
const OWNER_ADDRESS = { street_number: "1", street_name: "Demo Way", city: "College Park", state: "MD", zip: "20742" };
const OWNER_CUSTOMER = { first_name: "Allowance", last_name: "Owner", address: OWNER_ADDRESS };
const MERCHANT_GEOCODE = { lat: 38.9897, lng: -76.9378 };
/** One cent in USDC base units: anything smaller never reaches the bank. */
const CENT = 10_000n;
const MAX_TEXT = 120;
/** Deposits on an agent's account that are the second half of a top-up start with this. */
const TOPUP_DEPOSIT_PREFIX = "Top-up from";
const MAX_LINKS = 5000;

// ---------------------------------------------------------------------------
// Nessie client
// ---------------------------------------------------------------------------

/** A Nessie call failed. `status` 0 = network error or timeout. The message never contains the key. */
export class NessieError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable = status === 0 || status === 429 || status >= 500,
  ) {
    super(message);
    this.name = "NessieError";
  }
}

/** A Nessie object as returned on create or read. Ids are normalized to `_id` (transfer lists use `id`). */
export interface NessieObject {
  _id: string;
  [k: string]: unknown;
}

export interface NessieClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Minimum spacing between the starts of two writes (POSTs). Default 150 ms. */
  minWriteGapMs?: number;
  /** Per-call timeout. Default 10 s. */
  timeoutMs?: number;
}

export interface CallOpts {
  /** Overall deadline shared across several calls (the synchronous top-up). */
  signal?: AbortSignal;
}

/** `_id`, or `id` (Nessie's transfer lists), as `_id`; undefined when neither is a string. */
function withId(x: unknown): NessieObject | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const id = typeof o._id === "string" && o._id ? o._id : typeof o.id === "string" && o.id ? o.id : undefined;
  return id ? ({ ...o, _id: id } as NessieObject) : undefined;
}

export class NessieClient {
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #gap: number;
  readonly #timeout: number;
  #nextWriteAt = 0;

  constructor(opts: NessieClientOptions) {
    this.#key = opts.apiKey;
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? fetch;
    this.#gap = opts.minWriteGapMs ?? 150;
    this.#timeout = opts.timeoutMs ?? 10_000;
  }

  /** Replace the key anywhere in a string (Nessie or fetch could echo a URL back). */
  scrub(s: string): string {
    return this.#key ? s.split(this.#key).join("[redacted]") : s;
  }

  createCustomer(body: unknown, o?: CallOpts) {
    return this.#create("/customers", body, o);
  }
  createAccount(customerId: string, body: unknown, o?: CallOpts) {
    return this.#create(`/customers/${enc(customerId)}/accounts`, body, o);
  }
  async getAccount(id: string, o?: CallOpts): Promise<NessieObject> {
    const res = await this.#request<unknown>("GET", `/accounts/${enc(id)}`, undefined, o);
    return withId(res) ?? { _id: id, ...(res && typeof res === "object" ? res : {}) };
  }
  createTransfer(accountId: string, body: unknown, o?: CallOpts) {
    return this.#create(`/accounts/${enc(accountId)}/transfers`, body, o);
  }
  createPurchase(accountId: string, body: unknown, o?: CallOpts) {
    return this.#create(`/accounts/${enc(accountId)}/purchases`, body, o);
  }
  createDeposit(accountId: string, body: unknown, o?: CallOpts) {
    return this.#create(`/accounts/${enc(accountId)}/deposits`, body, o);
  }
  createMerchant(body: unknown, o?: CallOpts) {
    return this.#create("/merchants", body, o);
  }
  listPurchases(accountId: string, o?: CallOpts) {
    return this.#list(`/accounts/${enc(accountId)}/purchases`, undefined, o);
  }
  /** Transfers sit on the account that made them (Nessie has no payee): `type=payer`. */
  listTransfers(accountId: string, o?: CallOpts) {
    return this.#list(`/accounts/${enc(accountId)}/transfers`, { type: "payer" }, o);
  }
  listDeposits(accountId: string, o?: CallOpts) {
    return this.#list(`/accounts/${enc(accountId)}/deposits`, undefined, o);
  }
  listWithdrawals(accountId: string, o?: CallOpts) {
    return this.#list(`/accounts/${enc(accountId)}/withdrawals`, undefined, o);
  }

  /** POST → `objectCreated` (or the body itself), which must carry an id. */
  async #create(path: string, body: unknown, o?: CallOpts): Promise<NessieObject> {
    const res = await this.#request<{ objectCreated?: unknown }>("POST", path, body, o);
    const obj = withId(res && typeof res === "object" && res.objectCreated ? res.objectCreated : res);
    // It may have been created anyway; retrying could post twice, so this is not retryable.
    if (!obj) throw new NessieError(502, `Nessie POST ${path} answered without an id`, false);
    return obj;
  }

  /** Nessie answers an empty list with 404 ("No transfers found for this account"): that is no records. */
  async #list(path: string, query: Record<string, string> | undefined, o?: CallOpts): Promise<NessieObject[]> {
    let res: unknown;
    try {
      res = await this.#request<unknown>("GET", path, undefined, o, query);
    } catch (err) {
      if (err instanceof NessieError && err.status === 404) return [];
      throw err;
    }
    return Array.isArray(res) ? res.map(withId).filter((x): x is NessieObject => Boolean(x)) : [];
  }

  async #request<T>(method: "GET" | "POST", path: string, body: unknown, o: CallOpts = {}, query?: Record<string, string>): Promise<T> {
    const label = `Nessie ${method} ${path}`; // never the URL: it carries the key
    const url = new URL(`${this.#base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    url.searchParams.set("key", this.#key);
    if (method !== "GET") await this.#writeSlot(o.signal);
    const timeout = AbortSignal.timeout(this.#timeout);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal,
      });
    } catch (err) {
      const timedOut = signal.aborted || (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      throw new NessieError(0, `${label}: ${timedOut ? "timed out" : "could not reach Nessie"}`);
    }
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text || undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = errorDetail(parsed);
      throw new NessieError(res.status, this.scrub(`${label} answered ${res.status}${detail ? `: ${detail}` : ""}`).slice(0, 400));
    }
    return parsed as T;
  }

  /** Reserve the next write slot synchronously, so concurrent writers are spaced too. */
  async #writeSlot(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#nextWriteAt);
    this.#nextWriteAt = at + this.#gap;
    if (at > now) await sleep(at - now, signal);
  }
}

/** Nessie's error bodies: a JSON string listing the bad fields (validation), or `{ message, culprit }`. */
function errorDetail(b: unknown): string {
  if (typeof b === "string") return b;
  if (!b || typeof b !== "object") return "";
  const o = b as { message?: unknown; culprit?: unknown; detail?: unknown };
  const parts = [
    typeof o.message === "string" ? o.message : "",
    Array.isArray(o.culprit) ? o.culprit.filter((c) => typeof c === "string").join("; ") : "",
    o.detail !== undefined ? (typeof o.detail === "string" ? o.detail : JSON.stringify(o.detail)) : "",
  ];
  return parts.filter(Boolean).join(": ");
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Join an in-flight promise (a link another caller started) without outliving our own deadline. */
function within<T>(p: Promise<T>, o?: CallOpts): Promise<T> {
  const s = o?.signal;
  if (!s) return p;
  const timedOut = () => new NessieError(0, "Nessie: timed out");
  if (s.aborted) return Promise.reject(timedOut());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    s.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (s.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (s.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// money: integer cents at Nessie, dollar strings everywhere else
// ---------------------------------------------------------------------------

/** USDC base units → whole cents (rounded); undefined below one cent. */
function centsOf(units: bigint): number | undefined {
  if (units < CENT) return undefined;
  return Number((units + CENT / 2n) / CENT);
}
/** 2000 → "20.00" */
function centsToDollars(cents: number): string {
  return toDollars(BigInt(cents) * CENT);
}
const usdCents = (cents: number) => formatUsd(BigInt(cents) * CENT);
/** A Nessie amount or balance: an integer; anything else counts as 0. */
function intOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** One account's records at Nessie, enough to compute its balance and its statement. */
interface Ledger {
  opening: number;
  deposits: NessieObject[];
  withdrawals: NessieObject[];
  purchases: NessieObject[];
  transfers: NessieObject[];
}

const counts = (x: NessieObject) => String(x.status ?? "").toLowerCase() !== "cancelled";
const total = (xs: NessieObject[]) => xs.filter(counts).reduce((s, x) => s + intOf(x.amount), 0);
/** Nessie never moves `balance`: opening + deposits − withdrawals − purchases − transfers, in cents. */
function balanceCents(l: Ledger): number {
  return l.opening + total(l.deposits) - total(l.withdrawals) - total(l.purchases) - total(l.transfers);
}

// ---------------------------------------------------------------------------
// bank.json
// ---------------------------------------------------------------------------

export interface BankAccountRef {
  id: string;
  nickname: string;
  last4: string;
}

/** One queued Nessie write. `open` opens an agent's account; `refund` moves a top-up back to checking. */
export interface BankJob {
  id: string;
  kind: "open" | "topup" | "purchase" | "deposit" | "refund";
  agentId: string;
  agentName: string;
  receiptId?: string;
  /** Dollars, rounded to cents (posted to Nessie as cents). */
  amount?: string;
  description?: string;
  merchant?: { name: string; category: string };
  /** YYYY-MM-DD (local) of the Allowance event; sent as Nessie's transaction/purchase date. */
  date: string;
  /** Two-record jobs (topup, refund): the first record once posted, so a retry only does the second. */
  firstRef?: string;
  status: "pending" | "failed";
  attempts: number;
  /** ISO time of the next attempt (absent: due now). */
  nextAt?: string;
  error?: string;
  createdAt: string;
}

export interface BankFile {
  /** Nessie amounts are integer cents. A file without this is from a dollar-based link and relinks. */
  units: "cents";
  customerId?: string;
  checkingId?: string;
  checkingLast4?: string;
  accounts: Record<string, BankAccountRef>;
  merchants: Record<string, string>;
  /** Every Nessie object this wallet created, for cleanup by hand. */
  created: { kind: "customer" | "account" | "merchant"; id: string; at: string }[];
  queue: BankJob[];
  /** Last computed balances (dollars) by Nessie account id, served with `error` when Nessie can't be reached. */
  balances: Record<string, { balance: string; at: string }>;
  /** Second record of a two-record move → its first record (receipts carry the first as `bank.ref`). */
  links: Record<string, string>;
}

function emptyBankFile(): BankFile {
  return { units: "cents", accounts: {}, merchants: {}, created: [], queue: [], balances: {}, links: {} };
}

export function bankFilePath(dataDir: string): string {
  return join(dataDir, "bank.json");
}

function loadBankFile(file: string): { state: BankFile; legacy: boolean } {
  if (!existsSync(file)) return { state: emptyBankFile(), legacy: false };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Omit<BankFile, "units">> & { units?: unknown };
    const obj = <T>(v: unknown, d: T): T => (v && typeof v === "object" && !Array.isArray(v) ? (v as T) : d);
    const state: BankFile = {
      units: "cents",
      ...(typeof raw.customerId === "string" ? { customerId: raw.customerId } : {}),
      ...(typeof raw.checkingId === "string" ? { checkingId: raw.checkingId } : {}),
      ...(typeof raw.checkingLast4 === "string" ? { checkingLast4: raw.checkingLast4 } : {}),
      accounts: obj(raw.accounts, {}),
      merchants: obj(raw.merchants, {}),
      created: Array.isArray(raw.created) ? raw.created : [],
      queue: Array.isArray(raw.queue) ? raw.queue : [],
      balances: obj(raw.balances, {}),
      links: obj(raw.links, {}),
    };
    return { state, legacy: Boolean(raw.customerId || raw.checkingId) && raw.units !== "cents" };
  } catch (err) {
    console.error(`${LOG} could not parse ${file} (${(err as Error).message}); starting unlinked`);
    return { state: emptyBankFile(), legacy: false };
  }
}

// ---------------------------------------------------------------------------
// the bank
// ---------------------------------------------------------------------------

/** A bank failure with an HTTP mapping (the wallet turns it into its error body). */
export class BankError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BankError";
  }
}

export interface BankOptions {
  fetch?: typeof fetch;
  /** Default 150 ms. */
  minWriteGapMs?: number;
  /** Budget for the whole synchronous top-up. Default 10 s. */
  topupTimeoutMs?: number;
  /** Per-call timeout for queued jobs and reads. Default 10 s. */
  callTimeoutMs?: number;
  /** Delays before each retry of a queued job (5 retries over about 2 minutes by default). */
  retryDelaysMs?: number[];
  /** Computed balances are cached this long. Default 10 s. */
  balanceTtlMs?: number;
}

type Emit = (type: EventType, partial: Omit<WalletEvent, "id" | "type" | "at">) => WalletEvent;
type AgentRef = { id: string; name: string };

export interface Bank {
  /** NESSIE_API_KEY is set (and the base URL is usable). */
  readonly enabled: boolean;
  /** Owner customer and checking exist. */
  linked(): boolean;
  /** Link if needed, open accounts for agents without one, start the queue. Never blocks startup. */
  start(): void;
  close(): void;
  /** POST /v1/bank/link: idempotent. */
  link(): Promise<BankSummary>;
  /** GET /v1/bank. */
  summary(): Promise<BankSummary>;
  /** GET /v1/bank/statement. */
  statement(agentId?: string, limit?: number): Promise<BankStatementResponse>;
  /** SummaryResponse.bank, from the cache (refreshes in the background when stale). */
  cached(): SummaryResponse["bank"] | undefined;
  /** MeResponse.bank once the agent has an account. */
  agentBank(agentId: string): MeResponse["bank"] | undefined;
  /** Synchronous top-up. Throws BankError (409 bank_insufficient_funds, 502 bank_unavailable). */
  topup(agent: AgentRef, dollars: string): Promise<ReceiptBank>;
  /** Queue the mirror of a settled receipt (sets `receipt.bank` to queued). Caller saves and emits. */
  mirror(receipt: Receipt, merchant?: { name?: string; category?: string }): void;
  /** Queue opening the agent's account (no-op if it has one or one is on its way). */
  openAccount(agent: AgentRef): void;
  /** Queue moving a top-up back to checking (USDC could not be credited after the bank moved). */
  refund(agent: AgentRef, dollars: string, ref?: string): void;
  /** POST /v1/bank/retry: failed jobs back to the queue. Returns how many. */
  retry(receiptId?: string): number;
  /** /v1/reset: drop queued jobs. */
  clearQueue(): void;
  /** Tests: resolve once no job is pending (retries included) and nothing is running. */
  drain(timeoutMs?: number): Promise<void>;
  /** The file's state (tests and diagnostics; holds no secrets). */
  readonly state: BankFile;
}

const DEFAULT_RETRY_DELAYS = [5_000, 10_000, 20_000, 35_000, 50_000];

/** "Transfer to 0x12…ab" */
export function transferMerchantName(address: string): string {
  const a = address.toLowerCase();
  return `Transfer to ${a.slice(0, 4)}…${a.slice(-2)}`;
}

/** Nessie base URL: HTTPS, or plain HTTP only on loopback (the fake Nessie in tests). */
function usableBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function last4Of(obj: NessieObject): string {
  const n = typeof obj.account_number === "string" || typeof obj.account_number === "number" ? String(obj.account_number).replace(/\D/g, "") : "";
  return n.length >= 4 ? n.slice(-4) : obj._id.slice(-4);
}

const mask = (last4?: string) => (last4 ? `••${last4}` : "");
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const transferBody = (amount: number, date: string, description: string) => ({ amount, transaction_date: date, status: "completed", description: clip(description) });
const depositBody = (amount: number, date: string, description: string) => ({ medium: "balance", amount, transaction_date: date, status: "completed", description: clip(description) });

export function createBank(config: AppConfig, store: Store, emit: Emit, opts: BankOptions = {}): Bank {
  const key = config.nessie?.apiKey;
  const baseUrl = config.nessie?.baseUrl ?? "https://api.nessieisreal.com";
  if (key && !usableBaseUrl(baseUrl)) console.warn(`${LOG} NESSIE_BASE_URL must be https; the bank stays off`);
  const enabled = Boolean(key) && usableBaseUrl(baseUrl);
  const file = bankFilePath(config.dataDir);
  const loaded = enabled ? loadBankFile(file) : { state: emptyBankFile(), legacy: false };
  const state: BankFile = loaded.state;
  const client = new NessieClient({ apiKey: key ?? "", baseUrl, fetch: opts.fetch, minWriteGapMs: opts.minWriteGapMs, timeoutMs: opts.callTimeoutMs });
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const balanceTtl = opts.balanceTtlMs ?? 10_000;
  // NESSIE_OPENING_BALANCE is dollars ("5000.00"); Nessie gets cents (500000).
  const openingUnits = toBaseUnitsOr(config.nessie?.openingBalance, 5000n * 1_000_000n);
  const openingCents = openingUnits >= 0n ? Number((openingUnits + CENT / 2n) / CENT) : 500_000;

  let started = false;
  let closed = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: NodeJS.Timeout | undefined;
  let linking: Promise<void> | null = null;
  const openingAccounts = new Map<string, Promise<BankAccountRef>>();
  const merchantsInFlight = new Map<string, Promise<string>>();
  let balancesAt = 0;
  let refreshing: Promise<void> | null = null;
  let lastError: string | undefined;

  const errText = (err: unknown) => client.scrub(err instanceof Error ? err.message : String(err));
  const log = (msg: string) => console.log(`${LOG} ${client.scrub(msg)}`);
  const warn = (msg: string) => console.warn(`${LOG} ${client.scrub(msg)}`);

  function save(): void {
    if (!enabled) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  }

  function noteBalance(id: string, cents: number): void {
    state.balances[id] = { balance: centsToDollars(cents), at: nowIso() };
  }

  function link(second: string, first: string): void {
    state.links[second] = first;
    const keys = Object.keys(state.links);
    if (keys.length > MAX_LINKS) for (const k of keys.slice(0, keys.length - MAX_LINKS)) delete state.links[k];
  }

  /** Forget the link (a wiped sandbox, or a dollar-based bank.json): the next move links a new customer. */
  function forgetLink(): void {
    delete state.customerId;
    delete state.checkingId;
    delete state.checkingLast4;
    state.accounts = {};
    state.merchants = {};
    state.balances = {};
    for (const j of state.queue) delete j.firstRef; // their first records went with the old link
    balancesAt = 0;
    save();
  }

  if (loaded.legacy) {
    warn('bank.json is from a dollar-based link (no "units": "cents"); relinking with a new customer');
    forgetLink();
  }

  // ---- objects -------------------------------------------------------------

  /** Owner customer + checking (single flight; partial progress is kept). */
  function ensureLinked(o?: CallOpts): Promise<void> {
    if (state.customerId && state.checkingId) return Promise.resolve();
    linking ??= (async () => {
      try {
        if (!state.customerId) {
          const c = await client.createCustomer(OWNER_CUSTOMER, o);
          state.customerId = c._id;
          state.created.push({ kind: "customer", id: c._id, at: nowIso() });
          save();
        }
        if (!state.checkingId) {
          const a = await client.createAccount(state.customerId, { type: "Checking", nickname: CHECKING_NICKNAME, rewards: 0, balance: openingCents }, o);
          state.checkingId = a._id;
          state.checkingLast4 = last4Of(a);
          state.created.push({ kind: "account", id: a._id, at: nowIso() });
          noteBalance(a._id, a.balance === undefined ? openingCents : intOf(a.balance));
          save();
        }
        lastError = undefined;
        log(`linked: Capital One checking ${mask(state.checkingLast4)} (Nessie sandbox)`);
      } finally {
        linking = null;
      }
    })();
    return linking;
  }

  function accountNickname(agent: AgentRef): string {
    return `Allowance · ${agent.name}`;
  }

  /** The agent's allowance account, opened the first time it is needed (single flight per agent). */
  function ensureAgentAccount(agent: AgentRef, o?: CallOpts): Promise<BankAccountRef> {
    const existing = state.accounts[agent.id];
    if (existing) return Promise.resolve(existing);
    // After `npm run reset` the agent comes back under a new id: reuse its account by name.
    const nickname = accountNickname(agent);
    const orphan = Object.keys(state.accounts).find((k) => !store.agentById(k) && state.accounts[k].nickname === nickname);
    if (orphan) {
      state.accounts[agent.id] = state.accounts[orphan];
      delete state.accounts[orphan];
      save();
      log(`reusing ${nickname} ${mask(state.accounts[agent.id].last4)} for the new ${agent.name}`);
      return Promise.resolve(state.accounts[agent.id]);
    }
    let p = openingAccounts.get(agent.id);
    if (!p) {
      p = (async () => {
        try {
          await ensureLinked(o);
          const a = await client.createAccount(state.customerId!, { type: "Checking", nickname, rewards: 0, balance: 0 }, o);
          const ref: BankAccountRef = { id: a._id, nickname, last4: last4Of(a) };
          state.accounts[agent.id] = ref;
          state.created.push({ kind: "account", id: a._id, at: nowIso() });
          noteBalance(a._id, intOf(a.balance));
          save();
          log(`opened ${nickname} ${mask(ref.last4)}`);
          return ref;
        } finally {
          openingAccounts.delete(agent.id);
        }
      })();
      openingAccounts.set(agent.id, p);
    }
    return p;
  }

  /** One merchant per counterparty name, cached by name. */
  function ensureMerchant(name: string, category: string, o?: CallOpts): Promise<string> {
    const existing = state.merchants[name];
    if (existing) return Promise.resolve(existing);
    let p = merchantsInFlight.get(name);
    if (!p) {
      p = (async () => {
        try {
          const m = await client.createMerchant({ name, category, address: OWNER_ADDRESS, geocode: MERCHANT_GEOCODE }, o);
          state.merchants[name] = m._id;
          state.created.push({ kind: "merchant", id: m._id, at: nowIso() });
          save();
          return m._id;
        } finally {
          merchantsInFlight.delete(name);
        }
      })();
      merchantsInFlight.set(name, p);
    }
    return p;
  }

  /** Is this stored account gone at Nessie (404)? Other errors propagate. */
  async function gone(id: string, o?: CallOpts): Promise<boolean> {
    try {
      await client.getAccount(id, o);
      return false;
    } catch (err) {
      if (err instanceof NessieError && err.status === 404) return true;
      throw err;
    }
  }

  function forgetAll(why: string): void {
    warn(`${why} is gone at Nessie (sandbox wiped?); relinking`);
    forgetLink();
  }

  /**
   * Run `fn`; if Nessie answers 404 for a stored id, find which one is gone (checking first: a wiped
   * sandbox loses everything), forget it, log it, and run `fn` once more (it recreates what it needs).
   */
  async function withRelink<T>(ctx: { agent?: AgentRef; merchant?: string; o?: CallOpts }, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof NessieError) || err.status !== 404) throw err;
      if (state.checkingId && (await gone(state.checkingId, ctx.o))) {
        forgetAll(`checking ${mask(state.checkingLast4)}`);
      } else if (ctx.agent && state.accounts[ctx.agent.id] && (await gone(state.accounts[ctx.agent.id].id, ctx.o))) {
        const ref = state.accounts[ctx.agent.id];
        warn(`${ref.nickname} ${mask(ref.last4)} is gone at Nessie; opening a new one`);
        delete state.accounts[ctx.agent.id];
        save();
      } else if (ctx.merchant && state.merchants[ctx.merchant]) {
        warn(`merchant "${ctx.merchant}" is gone at Nessie; creating it again`);
        delete state.merchants[ctx.merchant];
        save();
      } else if (state.customerId && !state.checkingId) {
        forgetAll("the owner customer");
      } else {
        throw err;
      }
      return await fn();
    }
  }

  // ---- balances --------------------------------------------------------------

  /** The account's own records (an empty or missing list counts as none; a gone account still 404s on getAccount). */
  async function ledgerOf(id: string, o?: CallOpts): Promise<Ledger> {
    const [acct, deposits, withdrawals, purchases, transfers] = await Promise.all([
      client.getAccount(id, o),
      client.listDeposits(id, o),
      client.listWithdrawals(id, o),
      client.listPurchases(id, o),
      client.listTransfers(id, o),
    ]);
    return { opening: intOf(acct.balance), deposits, withdrawals, purchases, transfers };
  }

  /** Computed balances (checking + every agent's account), cached for balanceTtl; failures keep the last known. */
  function refreshBalances(force = false): Promise<void> {
    if (!enabled || !state.checkingId) return Promise.resolve();
    if (!force && Date.now() - balancesAt < balanceTtl) return Promise.resolve();
    refreshing ??= (async () => {
      try {
        const ids = [state.checkingId!, ...store.state.agents.map((a) => state.accounts[a.id]?.id).filter((x): x is string => Boolean(x))];
        const results = await mapLimit(ids, 3, async (id): Promise<"ok" | "gone" | { error: string }> => {
          try {
            noteBalance(id, balanceCents(await ledgerOf(id)));
            return "ok";
          } catch (err) {
            if (err instanceof NessieError && err.status === 404 && (await gone(id).catch(() => false))) return "gone";
            return { error: errText(err) };
          }
        });
        if (results[0] === "gone") {
          forgetAll(`checking ${mask(state.checkingLast4)}`);
          await ensureLinked();
          for (const a of store.state.agents) openAccount(a);
        } else {
          results.forEach((r, i) => {
            if (r !== "gone") return;
            const agentId = Object.keys(state.accounts).find((k) => state.accounts[k].id === ids[i]);
            if (!agentId) return;
            warn(`${state.accounts[agentId].nickname} is gone at Nessie; it reopens when money next moves`);
            const agent = store.agentById(agentId);
            delete state.accounts[agentId];
            if (agent) openAccount(agent);
          });
        }
        save();
        balancesAt = Date.now();
        const failure = results.find((r): r is { error: string } => typeof r === "object");
        if (failure) {
          warn(`could not read balances: ${failure.error}`);
          lastError = "Couldn't reach Capital One (Nessie sandbox); balances are the last known ones.";
        } else {
          lastError = undefined;
        }
      } catch (err) {
        balancesAt = Date.now(); // don't hammer Nessie while it's down
        warn(`could not read balances: ${errText(err)}`);
        lastError = "Couldn't reach Capital One (Nessie sandbox); balances are the last known ones.";
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  const balanceOf = (id: string) => state.balances[id]?.balance ?? "0.00";

  function buildSummary(): BankSummary {
    const updated = [state.checkingId, ...Object.values(state.accounts).map((a) => a.id)]
      .map((id) => (id ? state.balances[id]?.at : undefined))
      .filter((x): x is string => Boolean(x))
      .sort()
      .at(-1);
    return {
      enabled,
      linked: Boolean(state.customerId && state.checkingId),
      provider: PROVIDER,
      sandbox: SANDBOX,
      ...(state.checkingId
        ? { checking: { id: state.checkingId, nickname: CHECKING_NICKNAME, last4: state.checkingLast4 ?? state.checkingId.slice(-4), balance: balanceOf(state.checkingId) } }
        : {}),
      accounts: store.state.agents
        .filter((a) => state.accounts[a.id])
        .map((a) => {
          const ref = state.accounts[a.id];
          return { agentId: a.id, agentName: a.name, id: ref.id, nickname: ref.nickname, last4: ref.last4, balance: balanceOf(ref.id) };
        }),
      queue: {
        pending: state.queue.filter((j) => j.status === "pending").length,
        failed: state.queue.filter((j) => j.status === "failed").length,
      },
      ...(enabled && lastError ? { error: lastError } : {}),
      updatedAt: updated ?? nowIso(),
    };
  }

  // ---- queue -------------------------------------------------------------------

  function enqueue(job: Omit<BankJob, "id" | "status" | "attempts" | "createdAt" | "date"> & { date?: string }): BankJob {
    const full: BankJob = { id: newId("bjob"), status: "pending", attempts: 0, createdAt: nowIso(), ...job, date: job.date ?? localDayKey() };
    state.queue.push(full);
    save();
    kick();
    return full;
  }

  function kick(): void {
    if (!enabled || !started || closed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = processQueue()
      .catch((err: unknown) => warn(`queue stopped: ${errText(err)}`))
      .finally(() => {
        running = null;
        if (rerun) {
          rerun = false;
          kick();
        }
      });
  }

  async function processQueue(): Promise<void> {
    for (;;) {
      if (closed) return;
      rerun = false;
      const now = Date.now();
      const due = state.queue.find((j) => j.status === "pending" && (!j.nextAt || Date.parse(j.nextAt) <= now));
      if (!due) {
        scheduleNext();
        return;
      }
      await runJob(due);
    }
  }

  function scheduleNext(): void {
    clearTimeout(timer);
    const next = state.queue
      .filter((j) => j.status === "pending" && j.nextAt)
      .map((j) => Date.parse(j.nextAt!))
      .sort((a, b) => a - b)[0];
    if (next === undefined || closed) return;
    timer = setTimeout(kick, Math.max(0, next - Date.now()));
    timer.unref();
  }

  const topupDepositText = () => `${TOPUP_DEPOSIT_PREFIX} Capital One Checking ${mask(state.checkingLast4)}`;

  async function perform(job: BankJob): Promise<{ account: BankAccountRef; ref?: string }> {
    const agent: AgentRef = store.agentById(job.agentId) ?? { id: job.agentId, name: job.agentName };
    await ensureLinked();
    const account = await ensureAgentAccount(agent);
    const amount = job.amount ? Number((toBaseUnits(job.amount) + CENT / 2n) / CENT) : 0;
    const description = job.description ?? "";
    switch (job.kind) {
      case "open":
        return { account };
      case "topup": {
        // Transfer on checking (the money leaving), then the deposit on the agent's account.
        if (!job.firstRef) {
          job.firstRef = (await client.createTransfer(state.checkingId!, transferBody(amount, job.date, description)))._id;
          save();
        }
        const d = await client.createDeposit(account.id, depositBody(amount, job.date, topupDepositText()));
        link(d._id, job.firstRef);
        return { account, ref: job.firstRef };
      }
      case "refund": {
        // The mirror image: a transfer on the agent's account, then a deposit back on checking.
        if (!job.firstRef) {
          job.firstRef = (await client.createTransfer(account.id, transferBody(amount, job.date, description)))._id;
          save();
        }
        const d = await client.createDeposit(state.checkingId!, depositBody(amount, job.date, `Top-up reversed from ${agent.name}'s allowance account ${mask(account.last4)}`));
        link(d._id, job.firstRef);
        return { account, ref: job.firstRef };
      }
      case "purchase": {
        const merchantId = await ensureMerchant(job.merchant!.name, job.merchant!.category);
        const p = await client.createPurchase(account.id, { merchant_id: merchantId, medium: "balance", purchase_date: job.date, amount, status: "completed", description: clip(description) });
        return { account, ref: p._id };
      }
      case "deposit": {
        const d = await client.createDeposit(account.id, depositBody(amount, job.date, description));
        return { account, ref: d._id };
      }
    }
  }

  async function runJob(job: BankJob): Promise<void> {
    job.attempts += 1;
    const agent: AgentRef = { id: job.agentId, name: job.agentName };
    const receipt = job.receiptId ? store.receiptById(job.receiptId) : undefined;
    try {
      const { account, ref } = await withRelink({ agent, merchant: job.merchant?.name }, () => perform(job));
      state.queue = state.queue.filter((j) => j.id !== job.id);
      balancesAt = 0;
      save();
      if (!receipt) {
        if (job.kind !== "open") log(`${what(job)} posted (ref ${ref})`);
        return;
      }
      receipt.bank = { status: "posted", ref, account: mask(account.last4), postedAt: nowIso() };
      store.save();
      emit("bank.posted", {
        agentId: receipt.agentId,
        agentName: receipt.agentName,
        message: postedMessage(job, receipt, account),
        receipt,
        data: { receiptId: receipt.id, ref, kind: job.kind, account: mask(account.last4) },
      });
    } catch (err) {
      const msg = errText(err);
      const retryable = err instanceof NessieError && err.retryable;
      if (retryable && job.attempts <= retryDelays.length) {
        const delay = retryDelays[job.attempts - 1];
        job.nextAt = new Date(Date.now() + delay).toISOString();
        job.error = msg;
        save();
        warn(`${what(job)} failed (${msg}); retry ${job.attempts} of ${retryDelays.length} in ${Math.round(delay / 1000)}s`);
        return;
      }
      job.status = "failed";
      job.error = msg;
      delete job.nextAt;
      save();
      warn(`${what(job)} failed for good: ${msg}`);
      if (!receipt) return;
      const account = state.accounts[job.agentId];
      receipt.bank = { status: "failed", account: mask(account?.last4), error: msg };
      store.save();
      emit("bank.failed", {
        agentId: receipt.agentId,
        agentName: receipt.agentName,
        message: `${failedMessage(job)}: ${msg}`,
        reason: "bank_failed",
        receipt,
        data: { receiptId: receipt.id, kind: job.kind, error: msg },
      });
    }
  }

  function what(job: BankJob): string {
    const amt = job.amount ? formatUsd(toBaseUnits(job.amount)) : "";
    switch (job.kind) {
      case "open":
        return `opening ${job.agentName}'s account`;
      case "topup":
        return job.firstRef ? `the ${amt} top-up deposit for ${job.agentName}` : `the ${amt} top-up for ${job.agentName}`;
      case "refund":
        return `moving ${amt} back to checking from ${job.agentName}`;
      case "purchase":
        return `${job.agentName}'s ${amt} at ${job.merchant?.name}`;
      case "deposit":
        return `${job.agentName}'s ${amt} earning`;
    }
  }

  function failedMessage(job: BankJob): string {
    const amt = formatUsd(toBaseUnits(job.amount!));
    if (job.kind === "topup") return `Couldn't move ${amt} from Capital One Checking to ${job.agentName}'s allowance account`;
    if (job.kind === "deposit") return `Couldn't post ${job.agentName}'s ${amt} earning to Capital One`;
    return `Couldn't post ${job.agentName}'s ${amt} at ${job.merchant?.name} to Capital One`;
  }

  function postedMessage(job: BankJob, r: Receipt, account: BankAccountRef): string {
    const amt = formatUsd(toBaseUnits(job.amount!));
    const acct = `${r.agentName}'s Capital One account ${mask(account.last4)}`;
    if (job.kind === "topup") return `Moved ${amt} from Capital One Checking ${mask(state.checkingLast4)} to ${acct}.`;
    if (job.kind === "deposit") return `Deposited ${amt} into ${acct}.`;
    return `${amt} at ${job.merchant?.name} posted to ${acct}.`;
  }

  // ---- statement -------------------------------------------------------------

  function entryOf(o: NessieObject, kind: BankStatementEntry["kind"], receiptOf: (id: string) => string | undefined, merchantNames: Map<string, string>): BankStatementEntry {
    const merchantId = typeof o.merchant_id === "string" ? o.merchant_id : undefined;
    const merchant = merchantId ? merchantNames.get(merchantId) : undefined;
    const date = [o.purchase_date, o.transaction_date].find((d) => typeof d === "string") as string | undefined;
    const receiptId = receiptOf(o._id);
    return {
      id: o._id,
      kind,
      amount: centsToDollars(intOf(o.amount)),
      description: typeof o.description === "string" ? o.description : "",
      ...(merchant ? { merchant } : {}),
      date: date ?? "",
      status: typeof o.status === "string" ? o.status : "unknown",
      ...(receiptId ? { receiptId } : {}),
    };
  }

  /** Newest first: Nessie's date, then the id (Mongo ObjectIds start with their creation time). */
  function newestFirst(a: BankStatementEntry, b: BankStatementEntry): number {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }

  function requireEnabled(): void {
    if (!enabled) throw new BankError(409, "bank_not_enabled", "Capital One isn't set up: add NESSIE_API_KEY to .env and restart the wallet.");
  }

  function unavailable(err: unknown, what: string): BankError {
    if (err instanceof BankError) return err;
    warn(`${what} failed: ${errText(err)}`);
    return new BankError(502, "bank_unavailable", `Couldn't reach Capital One (Nessie sandbox) to ${what}; try again shortly.`);
  }

  // ---- public ------------------------------------------------------------------

  function openAccount(agent: AgentRef): void {
    if (!enabled || state.accounts[agent.id]) return;
    if (state.queue.some((j) => j.agentId === agent.id && j.status === "pending")) return;
    enqueue({ kind: "open", agentId: agent.id, agentName: agent.name });
  }

  const bank: Bank = {
    enabled,
    state,
    linked: () => Boolean(state.customerId && state.checkingId),

    start() {
      if (!enabled || started) return;
      started = true;
      // A restart is a good moment to retry: jobs waiting out a backoff run now.
      for (const j of state.queue) if (j.status === "pending") delete j.nextAt;
      void (async () => {
        try {
          await ensureLinked();
        } catch (err) {
          lastError = "Couldn't link Capital One (Nessie sandbox) yet; it retries as money moves.";
          warn(`could not link at startup: ${errText(err)}`);
        }
        for (const a of store.state.agents) openAccount(a);
        kick();
      })();
    },

    close() {
      closed = true;
      clearTimeout(timer);
    },

    async link() {
      requireEnabled();
      try {
        await withRelink({}, () => ensureLinked());
      } catch (err) {
        lastError = "Couldn't link Capital One (Nessie sandbox) yet; it retries as money moves.";
        throw unavailable(err, "link your accounts");
      }
      for (const a of store.state.agents) openAccount(a);
      await refreshBalances(true);
      return buildSummary();
    },

    async summary() {
      await refreshBalances();
      return buildSummary();
    },

    cached() {
      if (!enabled) return undefined;
      void refreshBalances();
      const linked = Boolean(state.customerId && state.checkingId);
      return {
        linked,
        ...(linked ? { checkingLast4: state.checkingLast4, checkingBalance: balanceOf(state.checkingId!) } : {}),
      };
    },

    agentBank(agentId) {
      const ref = enabled ? state.accounts[agentId] : undefined;
      return ref ? { provider: PROVIDER, account: ref.nickname, last4: ref.last4 } : undefined;
    },

    async statement(agentId, limit = 50) {
      requireEnabled();
      if (!state.checkingId) throw new BankError(409, "bank_not_linked", "Capital One isn't linked yet; link it first (POST /v1/bank/link).");
      const agent = agentId ? store.agentById(agentId) : undefined;
      if (agentId && !agent) throw new BankError(404, "agent_not_found", `No agent ${agentId}`);
      const n = Math.min(200, Math.max(1, Math.floor(limit) || 50));
      // Receipts carry the first record of a move as `bank.ref`; `links` maps second records to first ones.
      const refs = new Map<string, string>();
      for (const r of store.state.receipts) if (r.bank?.ref) refs.set(r.bank.ref, r.id);
      const receiptOf = (id: string) => refs.get(id) ?? (state.links[id] ? refs.get(state.links[id]) : undefined);
      const merchantNames = new Map(Object.entries(state.merchants).map(([name, id]) => [id, name]));
      try {
        return await withRelink({ agent }, async () => {
          await ensureLinked(); // no-op unless a wiped sandbox was just forgotten
          const ref = agent ? state.accounts[agent.id] : undefined;
          if (agent && !ref) throw new BankError(404, "bank_account_not_found", `${agent.name} has no Capital One account yet; it opens the first time money moves.`);
          const id = ref?.id ?? state.checkingId!;
          const ledger = await ledgerOf(id);
          noteBalance(id, balanceCents(ledger));
          save();
          const of = (o: NessieObject, kind: BankStatementEntry["kind"]) => entryOf(o, kind, receiptOf, merchantNames);
          // Agent: top-up deposits are money in from checking; other deposits are earnings.
          // Checking: deposits are money coming back (reversals). Transfers and withdrawals leave.
          const deposits = ledger.deposits.map((d) =>
            of(d, !ref || (typeof d.description === "string" && d.description.startsWith(TOPUP_DEPOSIT_PREFIX)) ? "transfer_in" : "deposit"),
          );
          const entries = [
            ...deposits,
            ...ledger.purchases.map((p) => of(p, "purchase")),
            ...ledger.transfers.map((t) => of(t, "transfer_out")),
            ...ledger.withdrawals.map((w) => of(w, "transfer_out")),
          ].sort(newestFirst);
          const account = ref
            ? { id: ref.id, nickname: ref.nickname, last4: ref.last4, balance: balanceOf(ref.id), agentId: agent!.id, agentName: agent!.name }
            : { id, nickname: CHECKING_NICKNAME, last4: state.checkingLast4 ?? id.slice(-4), balance: balanceOf(id) };
          return { account, entries: entries.slice(0, n) };
        });
      } catch (err) {
        throw unavailable(err, "load the statement");
      }
    },

    async topup(agent, dollars) {
      requireEnabled();
      const amount = centsOf(toBaseUnits(dollars));
      if (!amount) throw new BankError(400, "invalid_request", "Capital One moves whole cents; add at least $0.01.");
      const o: CallOpts = { signal: AbortSignal.timeout(opts.topupTimeoutMs ?? 10_000) };
      const date = localDayKey();
      const description = `Allowance top-up · ${agent.name}`;
      let moved: { account: BankAccountRef; ref: string };
      try {
        moved = await withRelink({ agent, o }, async () => {
          await within(ensureLinked(o), o);
          const account = await within(ensureAgentAccount(agent, o), o);
          const available = balanceCents(await ledgerOf(state.checkingId!, o));
          noteBalance(state.checkingId!, available);
          if (available < amount) {
            save();
            throw new BankError(409, "bank_insufficient_funds", `Your Capital One checking has ${usdCents(available)}, not enough to add ${usdCents(amount)}.`);
          }
          // The checking transfer is the bank's confirmation: only after it is the USDC credited.
          const t = await client.createTransfer(state.checkingId!, transferBody(amount, date, description), o);
          return { account, ref: t._id };
        });
      } catch (err) {
        if (err instanceof BankError) throw err;
        warn(`top-up of ${usdCents(amount)} for ${agent.name} failed: ${errText(err)}`);
        throw new BankError(502, "bank_unavailable", "Capital One didn't confirm the transfer, so nothing was added.");
      }
      // Then the deposit on the agent's account. If it fails the money is still on its way: queue it.
      try {
        const d = await client.createDeposit(moved.account.id, depositBody(amount, date, topupDepositText()), o);
        link(d._id, moved.ref);
      } catch (err) {
        warn(`the deposit half of ${agent.name}'s ${usdCents(amount)} top-up failed (${errText(err)}); queued`);
        enqueue({ kind: "topup", agentId: agent.id, agentName: agent.name, amount: centsToDollars(amount), description, date, firstRef: moved.ref });
      }
      balancesAt = 0;
      save();
      return { status: "posted", ref: moved.ref, account: mask(moved.account.last4), postedAt: nowIso() };
    },

    mirror(receipt, merchant) {
      if (!enabled || receipt.status !== "settled") return; // blocked, denied, pending and failed never reach the bank
      const cents = centsOf(BigInt(receipt.amountBaseUnits));
      if (!cents) return;
      const amount = centsToDollars(cents);
      const account = mask(state.accounts[receipt.agentId]?.last4);
      const base = { agentId: receipt.agentId, agentName: receipt.agentName, receiptId: receipt.id, amount };
      if (receipt.kind === "topup") {
        enqueue({ ...base, kind: "topup", description: `Allowance top-up · ${receipt.agentName}` });
      } else if (receipt.kind === "earn") {
        enqueue({ ...base, kind: "deposit", description: `Earned · ${receipt.description}` });
      } else {
        const name =
          receipt.kind === "transfer"
            ? transferMerchantName(receipt.counterparty.address)
            : clip(merchant?.name || receipt.counterparty.name || receipt.description || "Online payment", 60);
        enqueue({ ...base, kind: "purchase", description: `${receipt.description} · paid in USDC`, merchant: { name, category: merchant?.category || "online" } });
      }
      receipt.bank = { status: "queued", account };
    },

    openAccount,

    refund(agent, dollars, ref) {
      const cents = enabled ? centsOf(toBaseUnits(dollars)) : undefined;
      if (!cents) return;
      warn(`USDC for ${agent.name}'s top-up${ref ? ` (transfer ${ref})` : ""} could not be credited; moving ${usdCents(cents)} back to checking`);
      enqueue({ kind: "refund", agentId: agent.id, agentName: agent.name, amount: centsToDollars(cents), description: `Allowance top-up reversed · ${agent.name}` });
    },

    retry(receiptId) {
      requireEnabled();
      const failed = state.queue.filter((j) => j.status === "failed" && (!receiptId || j.receiptId === receiptId));
      for (const job of failed) {
        job.status = "pending";
        job.attempts = 0;
        delete job.nextAt;
        delete job.error;
        const receipt = job.receiptId ? store.receiptById(job.receiptId) : undefined;
        if (receipt) receipt.bank = { status: "queued", account: mask(state.accounts[job.agentId]?.last4) };
      }
      if (failed.length) {
        save();
        store.save();
        log(`${failed.length} failed job(s) back in the queue`);
        kick();
      }
      return failed.length;
    },

    clearQueue() {
      if (!enabled) return;
      state.queue = [];
      save();
    },

    async drain(timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const pending = state.queue.some((j) => j.status === "pending");
        if (!running && !pending && !linking && openingAccounts.size === 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("bank queue did not drain");
    },
  };
  return bank;
}

function toBaseUnitsOr(dollars: string | undefined, fallback: bigint): bigint {
  try {
    return dollars === undefined ? fallback : toBaseUnits(dollars);
  } catch {
    return fallback;
  }
}
