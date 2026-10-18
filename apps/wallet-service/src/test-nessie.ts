/**
 * A fake Capital One Nessie API for tests (docs/ARCHITECTURE.md §16): the subset the wallet uses,
 * in memory, on port 0. Creates answer `{ code: 201, message, objectCreated: { _id, … } }`; every
 * call must carry `?key=`. Ids look like Mongo ObjectIds (creation time first), as Nessie's do.
 *
 * Knobs: `fail` injects errors per route, `executeImmediately` decides whether transactions start
 * "executed" (balances move) or "pending" (they don't), `accountNumbers` whether accounts carry an
 * `account_number`, and `wipe()` empties everything like a sandbox reset.
 */
import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

type Obj = Record<string, unknown> & { _id: string };

export interface FakeFailure {
  method?: "GET" | "POST";
  /** Matched against the path (no query). */
  path: RegExp;
  /** HTTP status to answer, or "hang" (never answers) / "drop" (destroys the socket). */
  status: number | "hang" | "drop";
  /** How many matching requests fail (default: all). */
  times?: number;
  message?: string;
}

export interface FakeNessie {
  url: string;
  key: string;
  customers: Map<string, Obj>;
  accounts: Map<string, Obj>;
  merchants: Map<string, Obj>;
  transfers: Obj[];
  purchases: Obj[];
  deposits: Obj[];
  /** Every request, without the key: method, path, query (minus key), body. */
  requests: { method: string; path: string; query: Record<string, string>; body: unknown; at: number }[];
  /** Requests that arrived without the right key. */
  unauthorized: number;
  fail: FakeFailure[];
  executeImmediately: boolean;
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

export async function startFakeNessie(opts: { key: string; executeImmediately?: boolean; accountNumbers?: boolean; port?: number }): Promise<FakeNessie> {
  const fake: FakeNessie = {
    url: "",
    key: opts.key,
    customers: new Map(),
    accounts: new Map(),
    merchants: new Map(),
    transfers: [],
    purchases: [],
    deposits: [],
    requests: [],
    unauthorized: 0,
    fail: [],
    executeImmediately: opts.executeImmediately ?? true,
    accountNumbers: opts.accountNumbers ?? true,
    wipe() {
      fake.customers.clear();
      fake.accounts.clear();
      fake.merchants.clear();
      fake.transfers.length = 0;
      fake.purchases.length = 0;
      fake.deposits.length = 0;
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
      return void res.status(f.status).json({ code: f.status, message: f.message ?? "Simulated failure" });
    }
    next();
  });

  const created = (res: Response, message: string, obj: Obj) => res.status(201).json({ code: 201, message, objectCreated: obj });
  const notFound = (res: Response, what: string) => res.status(404).json({ code: 404, message: `Invalid ${what} id` });
  const bad = (res: Response, culprit: string[]) => res.status(400).json({ code: 400, message: "Invalid fields", culprit });
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const status = () => (fake.executeImmediately ? "executed" : "pending");

  app.post("/customers", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.first_name !== "string" || typeof b.last_name !== "string" || typeof b.address !== "object") return void bad(res, ["first_name", "last_name", "address"]);
    const c: Obj = { _id: objectId(), first_name: b.first_name, last_name: b.last_name, address: b.address };
    fake.customers.set(c._id, c);
    created(res, "Created customer", c);
  });

  app.post("/customers/:id/accounts", (req, res) => {
    if (!fake.customers.has(String(req.params.id))) return void notFound(res, "customer");
    const b = req.body ?? {};
    if (!["Checking", "Savings", "Credit Card"].includes(b.type) || typeof b.nickname !== "string" || !num(b.rewards) || !num(b.balance)) {
      return void bad(res, ["type", "nickname", "rewards", "balance"]);
    }
    const a: Obj = {
      _id: objectId(),
      type: b.type,
      nickname: b.nickname,
      rewards: b.rewards,
      balance: b.balance,
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

  const move = (fromId: string | undefined, toId: string | undefined, amount: number) => {
    if (!fake.executeImmediately) return;
    if (fromId) fake.accounts.get(fromId)!.balance = Math.round(((fake.accounts.get(fromId)!.balance as number) - amount) * 100) / 100;
    if (toId) fake.accounts.get(toId)!.balance = Math.round(((fake.accounts.get(toId)!.balance as number) + amount) * 100) / 100;
  };

  app.post("/accounts/:id/transfers", (req, res) => {
    const payer = String(req.params.id);
    const b = req.body ?? {};
    if (!fake.accounts.has(payer)) return void notFound(res, "payer");
    if (!fake.accounts.has(b.payee_id)) return void notFound(res, "payee");
    if (b.medium !== "balance" || !num(b.amount) || b.amount <= 0) return void bad(res, ["medium", "amount"]);
    const t: Obj = { _id: objectId(), type: "p2p", transaction_date: b.transaction_date, status: status(), medium: b.medium, payer_id: payer, payee_id: b.payee_id, amount: b.amount, description: b.description };
    fake.transfers.push(t);
    move(payer, b.payee_id, b.amount);
    created(res, "Transfer created", t);
  });

  app.post("/accounts/:id/purchases", (req, res) => {
    const payer = String(req.params.id);
    const b = req.body ?? {};
    if (!fake.accounts.has(payer)) return void notFound(res, "account");
    if (!fake.merchants.has(b.merchant_id)) return void notFound(res, "merchant");
    if (b.medium !== "balance" || !num(b.amount) || b.amount <= 0) return void bad(res, ["medium", "amount"]);
    const p: Obj = { _id: objectId(), type: "merchant", merchant_id: b.merchant_id, payer_id: payer, purchase_date: b.purchase_date, amount: b.amount, status: status(), medium: b.medium, description: b.description };
    fake.purchases.push(p);
    move(payer, undefined, b.amount);
    created(res, "Created purchase", p);
  });

  app.post("/accounts/:id/deposits", (req, res) => {
    const payee = String(req.params.id);
    const b = req.body ?? {};
    if (!fake.accounts.has(payee)) return void notFound(res, "account");
    if (b.medium !== "balance" || !num(b.amount) || b.amount <= 0) return void bad(res, ["medium", "amount"]);
    const d: Obj = { _id: objectId(), type: "deposit", transaction_date: b.transaction_date, status: status(), medium: b.medium, payee_id: payee, amount: b.amount, description: b.description };
    fake.deposits.push(d);
    move(undefined, payee, b.amount);
    created(res, "Created deposit", d);
  });

  const list = (pick: (req: Request) => Obj[]) => (req: Request, res: Response) => {
    if (!fake.accounts.has(String(req.params.id))) return void notFound(res, "account");
    res.json(pick(req));
  };
  app.get("/accounts/:id/purchases", list((req) => fake.purchases.filter((p) => p.payer_id === req.params.id)));
  app.get("/accounts/:id/deposits", list((req) => fake.deposits.filter((d) => d.payee_id === req.params.id)));
  app.get(
    "/accounts/:id/transfers",
    list((req) => fake.transfers.filter((t) => (req.query.type === "payee" ? t.payee_id === req.params.id : req.query.type === "payer" ? t.payer_id === req.params.id : t.payer_id === req.params.id || t.payee_id === req.params.id))),
  );

  app.post("/merchants", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.name !== "string" || !b.name) return void bad(res, ["name"]);
    const m: Obj = { _id: objectId(), name: b.name, category: b.category, address: b.address, geocode: b.geocode };
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
