/**
 * Scheduler HTTP API (§20.3), default http://localhost:4100.
 *
 * Agent API (Bearer agent token, verified with the wallet's /v1/me): an agent sees and changes only
 * its own schedules, and sees but can't remove its owner's rules.
 * Owner API (X-Owner-Key): every schedule, cancel any, rules per agent, and the pause switch.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { AGENT_NAME_RE } from "@allowance/shared";
import { Scheduler, SchedulerError } from "./engine.js";
import { WalletUnavailableError, type AgentIdentity, type WalletAuth } from "./wallet.js";

export interface SchedulerAppOptions {
  scheduler: Scheduler;
  wallet: WalletAuth;
  ownerApiKey: string;
  quiet?: boolean;
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Turns thrown SchedulerErrors into `{ error, message }` with their status. */
const route =
  (fn: Handler): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SchedulerError) return void res.status(err.status).json({ error: err.code, message: err.message });
      if (err instanceof WalletUnavailableError) return void res.status(503).json({ error: "wallet_unavailable", message: err.message });
      next(err);
    }
  };

export function createSchedulerApp(opts: SchedulerAppOptions): express.Express {
  const { scheduler, wallet } = opts;
  const log = opts.quiet ? () => {} : (m: string) => console.log(`[scheduler] ${m}`);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    if (req.path !== "/health") res.on("finish", () => log(`${req.method} ${req.path} -> ${res.statusCode}`));
    next();
  });

  const status = () => ({ paused: scheduler.paused, ...(scheduler.pausedAt ? { pausedAt: scheduler.pausedAt } : {}), limits: scheduler.limits });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, paused: scheduler.paused, active: scheduler.list().length });
  });

  // ---- agent API ------------------------------------------------------------------------------
  const withAgent: RequestHandler = async (req, res, next) => {
    const auth = req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!/^aw_[0-9a-f]{48}$/.test(token)) return void res.status(401).json({ error: "unauthorized", message: "Authorization: Bearer <agent token> required" });
    let who: AgentIdentity | null;
    try {
      who = await wallet.me(token);
    } catch (err) {
      if (err instanceof WalletUnavailableError) return void res.status(503).json({ error: "wallet_unavailable", message: err.message });
      return next(err);
    }
    if (!who) return void res.status(401).json({ error: "token_rejected", message: "The wallet does not recognize this agent token" });
    res.locals.agent = who;
    next();
  };
  const agentOf = (res: Response) => res.locals.agent as AgentIdentity;

  // ---- owner key check ------------------------------------------------------------------------
  /** true: a valid X-Owner-Key; false: none sent; a wrong key answers 401 here. */
  const ownerKey = (req: Request, res: Response): boolean | null => {
    const given = req.header("x-owner-key");
    if (given === undefined) return false;
    if (safeEqual(given, opts.ownerApiKey)) return true;
    res.status(401).json({ error: "unauthorized", message: "X-Owner-Key is wrong" });
    return null;
  };
  const ownerOnly: RequestHandler = (req, res, next) => {
    const o = ownerKey(req, res);
    if (o === null) return;
    if (!o) return void res.status(401).json({ error: "unauthorized", message: "X-Owner-Key required" });
    next();
  };
  /** The shared paths serve the owner (X-Owner-Key: everything) or an agent (Bearer: its own). */
  const ownerOrAgent: RequestHandler = (req, res, next) => {
    const o = ownerKey(req, res);
    if (o === null) return;
    if (o) {
      res.locals.owner = true;
      return next();
    }
    return withAgent(req, res, next);
  };
  const isOwner = (res: Response) => res.locals.owner === true;

  const ownerList = (req: Request) => {
    const agentName = typeof req.query.agent === "string" && req.query.agent ? req.query.agent : undefined;
    const includeEnded = req.query.all === "1" || req.query.all === "true";
    return {
      schedules: scheduler.list({ agentName, includeEnded }).map((s) => scheduler.view(s)),
      ...status(),
      firingsToday: scheduler.allFiringsToday(),
      firings: scheduler.firings({ agentName }),
    };
  };

  // ---- schedules (agent: its own; owner: all) -----------------------------------------------------
  app.post(
    "/schedules",
    withAgent,
    route(async (req, res) => {
      const agent = agentOf(res);
      const s = await scheduler.create(agent, req.body ?? {}, "agent");
      res.status(201).json({ schedule: scheduler.view(s), needsChat: Boolean(s.needsChat), ...status(), firingsToday: scheduler.firingsToday(agent.name) });
    }),
  );

  app.get(
    "/schedules",
    ownerOrAgent,
    route((req, res) => {
      if (isOwner(res)) return void res.json(ownerList(req));
      const agent = agentOf(res);
      const includeEnded = req.query.all === "1" || req.query.all === "true";
      res.json({ schedules: scheduler.list({ agentName: agent.name, includeEnded }).map((s) => scheduler.view(s)), ...status(), firingsToday: scheduler.firingsToday(agent.name) });
    }),
  );

  app.delete(
    "/schedules/:id",
    ownerOrAgent,
    route((req, res) => {
      const s = isOwner(res) ? scheduler.cancel(String(req.params.id), "owner") : scheduler.cancel(String(req.params.id), "agent", agentOf(res).name);
      res.json({ schedule: scheduler.view(s) });
    }),
  );

  // ---- owner API ------------------------------------------------------------------------------
  app.get("/owner/schedules", ownerOnly, (req, res) => {
    res.json(ownerList(req));
  });

  app.delete(
    "/owner/schedules/:id",
    ownerOnly,
    route((req, res) => {
      res.json({ schedule: scheduler.view(scheduler.cancel(String(req.params.id), "owner")) });
    }),
  );

  /**
   * Owner rules. One rule: `{ agent, type, value, ticker?, everyMinutes? }`. Or the dashboard's rule
   * set for one agent: `{ agentName, takeProfitPct?, stopLossPct?, cashOutAbove? }` (empty = off).
   */
  const rules = route(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.agent === "string" ? b.agent.trim() : typeof b.agentName === "string" ? b.agentName.trim() : "";
    if (!AGENT_NAME_RE.test(name)) return void res.status(400).json({ error: "invalid_request", message: "Body must name the agent: { agent, type, value, ticker? } or { agentName, takeProfitPct?, stopLossPct?, cashOutAbove? }" });
    const who = await wallet.agentByName(name);
    if (!who) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${name}` });
    if (b.type !== undefined) {
      const { schedule, replaced } = await scheduler.createRule(who, b);
      return void res.status(201).json({ schedule: scheduler.view(schedule), ...(replaced ? { replaced: scheduler.view(replaced) } : {}) });
    }
    const { rules: list, removed } = await scheduler.setRules(who, b);
    res.json({ agent: name, rules: list.map((s) => scheduler.view(s)), removed: removed.map((s) => scheduler.view(s)) });
  });
  app.post("/owner/rules", ownerOnly, rules);
  app.post("/rules", ownerOnly, rules);

  const pause: RequestHandler = (_req, res) => {
    scheduler.pause();
    res.json(status());
  };
  const resume: RequestHandler = (_req, res) => {
    scheduler.resume();
    res.json(status());
  };
  app.post("/pause", ownerOnly, pause);
  app.post("/resume", ownerOnly, resume);
  app.post("/owner/pause", ownerOnly, pause);
  app.post("/owner/resume", ownerOnly, resume);
  const ownerStatus: RequestHandler = (_req, res) => {
    res.json({ ...status(), state: scheduler.paused ? "paused" : "running", active: scheduler.list().length, firingsToday: scheduler.allFiringsToday() });
  };
  app.get("/status", ownerOnly, ownerStatus);
  app.get("/owner/status", ownerOnly, ownerStatus);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", message: "No such route" });
  });
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid_json", message: "The body is not valid JSON" });
    console.warn(`[scheduler] ${err.message}`);
    res.status(500).json({ error: "internal_error", message: "Something went wrong in the scheduler" });
  });
  return app;
}
