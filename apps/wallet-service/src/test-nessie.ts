/**
 * A fake Capital One Nessie API for tests (docs/ARCHITECTURE.md §16), in memory, behaving like the
 * real one as verified live on 2026-10-18:
 * - bodies are validated strictly: missing or extra fields are a 400 whose body is a JSON string
 *   listing the bad fields;
 * - amounts are stored as integers (truncated): 0.05 becomes 0;
 * - `balance` never changes, whatever is posted;
 * - a transfer sits on one account (no payee); transfer list items carry `id`, not `_id`;
 * - creates answer `{ code: 201, message, objectCreated: { _id, … } }`; every call needs `?key=`.
 * Ids look like Mongo ObjectIds (creation time first), as Nessie's do.
 *
 * Knobs: `fail` injects errors per route, `accountNumbers` decides whether accounts carry an
 * `account_number`, and `wipe()` empties everything like a sandbox reset. Tests may edit stored
 * records directly (e.g. set a purchase's status to "cancelled").
 */
import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

type Obj = Record<string, unknown> & { _id: string };
/** Transfers as Nessie lists them: `id`, not `_id`. */
type Transfer = Record<string, unknown> & { id: string };

export interface FakeFailure {
  method?: "GET" | "POST";
  /** Matched against the path (no query). */
  path: RegExp;
  /** HTTP status to answer, or "hang" (never answers) / "drop" (destroys the socket). */
  status: number | "hang" | "drop";
  /** How many matching requests fail (default: all). */
  times?: number;
  message?: string;
  /** Answer with a bare JSON string body, like Nessie's validation errors. */
  stringBody?: boolean;
}

export interface FakeNessie {
  url: string;
  key: string;
  customers: Map<string, Obj>;
  accounts: Map<string, Obj>;
  merchants: Map<string, Obj>;
  transfers: Transfer[];
  purchases: Obj[];
  deposits: Obj[];
  withdrawals: Obj[];
  /** Every request, without the key: method, path, query (minus key), body, arrival time. */
  requests: { method: string; path: string; query: Record<string, string>; body: unknown; at: number }[];
  /** Requests that arrived without the right key. */
  unauthorized: number;
  /** 400s for bad bodies (missing or extra fields), as Nessie would send them. */
  rejected: { path: string; problems: string[] }[];
  fail: FakeFailure[];
  accountNumbers: boolean;
  /** Forget everything (a wiped sandbox): stored ids now 404. */
  wipe(): void;
  writes(path?: RegExp): { method: string; path: string; body: unknown }[];
  close(): Promise<void>;
}

const machine = randomBytes(5).toString("hex");
let counter = Math.floor(Math.random() * 0xffff);
function objectId(): string {
  const t = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  counter = (counter + 1) % 0xffffff;
  return `${t}${machine}${counter.toString(16).padStart(6, "0")}`;
}

/** Fields per body, as the real API validates them (verified 2026-10-18). */
const SPECS = {
  customer: { required: ["first_name", "last_name", "address"], optional: [] },
  account: { required: ["type", "nickname", "rewards", "balance"], optional: ["account_number"] },
  transfer: { required: ["amount", "transaction_date", "status", "description"], optional: [] },
  deposit: { required: ["medium", "amount", "transaction_date", "status", "description"], optional: [] },
  withdrawal: { required: ["medium", "amount"], optional: ["transaction_date", "status", "description"] },
  purchase: { required: ["merchant_id", "medium", "amount"], optional: ["purchase_date", "status", "description"] },
  merchant: { required: ["name"], optional: ["category", "address", "geocode"] },
} as const;

function problemsOf(body: unknown, spec: { required: readonly string[]; optional: readonly string[] }): string[] {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  const out: string[] = [];
  for (const f of spec.required) if (b[f] === undefined || b[f] === null) out.push(`${f}: field required`);
  for (const f of Object.keys(b)) if (!allowed.has(f)) out.push(`${f}: extra fields not permitted`);
  if ("amount" in b && (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount < 0)) out.push("amount: value is not a valid number");
  if ("balance" in b && (typeof b.balance !== "number" || !Number.isFinite(b.balance))) out.push("balance: value is not a valid number");
  if ("rewards" in b && typeof b.rewards !== "number") out.push("rewards: value is not a valid number");
  if ("status" in b && !["pending", "completed"].includes(String(b.status))) out.push("status: value is not a valid enumeration member");
  if ("medium" in b && !["balance", "rewards"].includes(String(b.medium))) out.push("medium: value is not a valid enumeration member");
  if ("type" in b && spec === SPECS.account && !["Checking", "Savings", "Credit Card"].includes(String(b.type))) out.push("type: value is not a valid enumeration member");
  return out;
}

export async function startFakeNessie(opts: { key: string; accountNumbers?: boolean; port?: number }): Promise<FakeNessie> {
  const fake: FakeNessie = {
    url: "",
    key: opts.key,
    customers: new Map(),
    accounts: new Map(),
    merchants: new Map(),
    transfers: [],
    purchases: [],
    deposits: [],
    withdrawals: [],
    requests: [],
    unauthorized: 0,
    rejected: [],
    fail: [],
    accountNumbers: opts.accountNumbers ?? true,
    wipe() {
      fake.customers.clear();
      fake.accounts.clear();
      fake.merchants.clear();
      fake.transfers.length = 0;
      fake.purchases.length = 0;
      fake.deposits.length = 0;
      fake.withdrawals.length = 0;
    },
    writes: (path) => fake.requests.filter((r) => r.method === "POST" && (!path || path.test(r.path))),
    close: async () => {},
  };
  const hanging = new Set<Response>();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const { key, ...query } = req.query as Record<string, string>;
    fake.requests.push({ method: req.method, path: req.path, query, body: req.body, at: Date.now() });
    if (key !== fake.key) {
      fake.unauthorized++;
      return void res.status(401).json({ code: 401, message: "unauthorized" });
    }
    const f = fake.fail.find((x) => (!x.method || x.method === req.method) && x.path.test(req.path) && (x.times === undefined || x.times > 0));
    if (f) {
      if (f.times !== undefined) f.times--;
      if (f.status === "hang") return void hanging.add(res);
      if (f.status === "drop") return void req.socket.destroy();
      const message = f.message ?? "Simulated failure";
      return void res.status(f.status).json(f.stringBody ? message : { code: f.status, message });
    }
    next();
  });

  const created = (res: Response, message: string, obj: Record<string, unknown> & { _id: string }) => res.status(201).json({ code: 201, message, objectCreated: obj });
  const notFound = (res: Response, what: string) => res.status(404).json({ code: 404, message: `Invalid ${what} id` });
  /** Nessie's validation 400: the body is a JSON string listing the bad fields. */
  const invalid = (req: Request, res: Response, spec: (typeof SPECS)[keyof typeof SPECS]): boolean => {
    const problems = problemsOf(req.body, spec);
    if (!problems.length) return false;
    fake.rejected.push({ path: req.path, problems });
    res.status(400).json(JSON.stringify(problems.map((p) => ({ loc: ["body", p.split(":")[0]], msg: p.split(": ")[1] }))));
    return true;
  };
  const int = (v: unknown) => Math.trunc(Number(v));

  app.post("/customers", (req, res) => {
    if (invalid(req, res, SPECS.customer)) return;
    const c: Obj = { _id: objectId(), ...req.body };
    fake.customers.set(c._id, c);
    created(res, "Created customer", c);
  });

  app.post("/customers/:id/accounts", (req, res) => {
    if (!fake.customers.has(String(req.params.id))) return void notFound(res, "customer");
    if (invalid(req, res, SPECS.account)) return;
    const b = req.body;
    const a: Obj = {
      _id: objectId(),
      type: b.type,
      nickname: b.nickname,
      rewards: b.rewards,
      balance: int(b.balance),
      customer_id: String(req.params.id),
      ...(fake.accountNumbers ? { account_number: String(4_000_000_000_000_000 + Math.floor(Math.random() * 1e12)) } : {}),
    };
    fake.accounts.set(a._id, a);
    created(res, "Account created", a);
  });

  app.get("/accounts/:id", (req, res) => {
    const a = fake.accounts.get(String(req.params.id));
    if (!a) return void notFound(res, "account");
    res.json(a);
  });

  // Balances never change: posting a record only stores it.
  app.post("/accounts/:id/transfers", (req, res) => {
    const payer = String(req.params.id);
    if (!fake.accounts.has(payer)) return void notFound(res, "account");
    if (invalid(req, res, SPECS.transfer)) return;
    const b = req.body;
    const t: Transfer = { id: objectId(), type: "p2p", transaction_date: b.transaction_date, status: b.status, payer_id: payer, amount: int(b.amount), description: b.description };
    fake.transfers.push(t);
    const { id, ...rest } = t;
    created(res, "Transfer created", { _id: id, ...rest });
  });

  app.post("/accounts/:id/purchases", (req, res) => {
    const payer = String(req.params.id);
    if (!fake.accounts.has(payer)) return void notFound(res, "account");
    if (invalid(req, res, SPECS.purchase)) return;
    const b = req.body;
    if (!fake.merchants.has(b.merchant_id)) return void notFound(res, "merchant");
    const p: Obj = { _id: objectId(), type: "merchant", merchant_id: b.merchant_id, payer_id: payer, purchase_date: b.purchase_date, amount: int(b.amount), status: b.status ?? "pending", medium: b.medium, description: b.description };
    fake.purchases.push(p);
    created(res, "Created purchase", p);
  });

  app.post("/accounts/:id/deposits", (req, res) => {
    const payee = String(req.params.id);
    if (!fake.accounts.has(payee)) return void notFound(res, "account");
    if (invalid(req, res, SPECS.deposit)) return;
    const b = req.body;
    const d: Obj = { _id: objectId(), type: "deposit", transaction_date: b.transaction_date, status: b.status, medium: b.medium, payee_id: payee, amount: int(b.amount), description: b.description };
    fake.deposits.push(d);
    created(res, "Created deposit", d);
  });

  app.post("/accounts/:id/withdrawals", (req, res) => {
    const payer = String(req.params.id);
    if (!fake.accounts.has(payer)) return void notFound(res, "account");
    if (invalid(req, res, SPECS.withdrawal)) return;
    const b = req.body;
    const w: Obj = { _id: objectId(), type: "withdrawal", transaction_date: b.transaction_date, status: b.status ?? "pending", medium: b.medium, payer_id: payer, amount: int(b.amount), description: b.description };
    fake.withdrawals.push(w);
    created(res, "Created withdrawal", w);
  });

  // Like the real Nessie, an empty list is a 404 with a JSON string ("No transfers found for this account").
  const list = (noun: string, pick: (req: Request) => unknown[]) => (req: Request, res: Response) => {
    if (!fake.accounts.has(String(req.params.id))) return void notFound(res, "account");
    const rows = pick(req);
    if (!rows.length) return void res.status(404).json(`No ${noun} found for this account`);
    res.json(rows);
  };
  app.get("/accounts/:id/purchases", list("purchases", (req) => fake.purchases.filter((p) => p.payer_id === req.params.id)));
  app.get("/accounts/:id/deposits", list("deposits", (req) => fake.deposits.filter((d) => d.payee_id === req.params.id)));
  app.get("/accounts/:id/withdrawals", list("withdrawals", (req) => fake.withdrawals.filter((w) => w.payer_id === req.params.id)));
  // No payees: `type=payer` (or no type) lists the account's own transfers; `type=payee` lists none.
  app.get("/accounts/:id/transfers", list("transfers", (req) => (req.query.type === "payee" ? [] : fake.transfers.filter((t) => t.payer_id === req.params.id))));

  app.post("/merchants", (req, res) => {
    if (invalid(req, res, SPECS.merchant)) return;
    const m: Obj = { _id: objectId(), ...req.body };
    fake.merchants.set(m._id, m);
    created(res, "Created merchant", m);
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port ?? 0, "127.0.0.1", () => resolve(s));
  });
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise((resolve) => {
      for (const res of hanging) res.socket?.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
