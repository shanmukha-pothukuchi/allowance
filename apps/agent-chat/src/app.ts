/**
 * HTTP + SSE server for the chat agents (default http://localhost:4050).
 *
 * This is an agent-side process: it holds agent tokens (like Claude Desktop does) and never the
 * owner key. Owner actions (approve, unfreeze) stay on Telegram and the dashboard.
 */
import express, { type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { avatarFor, type Avatar } from "@allowance/shared/avatars";
import { ChatAgent, BusyError, type AgentEvent, type LogEntry, type ScheduledMeta } from "./agent.js";
import { groupMembers, roleFor, type AgentSpec } from "./roster.js";
import { GroupStore, GroupError, defaultGroups } from "./groups.js";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AGENT_NAME_RE, type ShopifyStoreRef } from "@allowance/shared";
import type { LlmConfig } from "./llm.js";
import { fontsDir, renderChatPage, staticDir } from "./ui.js";

export interface WalletView {
  address?: string;
  balance?: string;
  spentToday?: string;
  earnedToday?: string;
  frozen?: boolean;
  frozenReason?: string;
  limits?: { maxPerTx: string; dailyCap: string; approvalThreshold: string; remainingToday: string };
  /** The agent's Capital One allowance account (Nessie sandbox, §16) when the wallet reports one. No balance. */
  bank?: BankRef;
  error?: string;
}

export interface BankRef {
  provider: "Capital One";
  /** "Allowance · researcher" */
  account: string;
  /** "5678" (the page shows "Capital One ••5678") */
  last4: string;
}

/** `/v1/me`'s bank as plain strings the page can print: anything unexpected is dropped, not passed on. */
export function bankRef(x: unknown): BankRef | undefined {
  if (!x || typeof x !== "object") return undefined;
  const b = x as Record<string, unknown>;
  if (b.provider !== "Capital One" || typeof b.last4 !== "string" || !/^[0-9A-Za-z]{1,8}$/.test(b.last4)) return undefined;
  const account = typeof b.account === "string" ? b.account.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 80) : "";
  return { provider: "Capital One", account, last4: b.last4 };
}

/** A connected service as shown on the agent's chips (from the /v1/me poll). */
export interface ServiceChip {
  id: string;
  name: string;
  icon: string;
  color: string;
  pricing?: string;
  maxPrice?: string;
  /** Shopify stores (ShopifyStoreRef), so the page needn't infer them from tool text. */
  shopify?: ShopifyStoreRef;
}

/** A store ref from the wallet poll, as plain strings (the page renders it; https storefront links only). */
function shopifyRef(x: Partial<ShopifyStoreRef>): ShopifyStoreRef {
  const domain = String(x.domain ?? "");
  const storefront = typeof x.storefrontUrl === "string" && /^https:\/\/[^\s"'<>]+$/.test(x.storefrontUrl) ? x.storefrontUrl : `https://${domain}`;
  return { handle: String(x.handle ?? ""), domain, storefrontUrl: storefront, cardCheckout: x.cardCheckout === true };
}

/** Preview for the conversation list: the last user / assistant / error entry. */
export interface LastMessage {
  kind: "user" | "assistant" | "error";
  text: string;
  at: string;
  groupId?: string;
}

/** One row of GET /api/agents (and the SSE snapshot). */
export interface AgentSummary {
  name: string;
  role: string;
  status: ChatAgent["status"];
  busy: boolean;
  wallet: WalletView;
  avatar: Avatar;
  services: ServiceChip[];
  lastMessage: LastMessage | null;
}

const PREVIEW_CHARS = 280;

export function lastMessageOf(log: LogEntry[]): LastMessage | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === "user" || e.kind === "assistant" || e.kind === "error") {
      const text = e.text.length > PREVIEW_CHARS ? `${e.text.slice(0, PREVIEW_CHARS - 1)}…` : e.text;
      return { kind: e.kind, text, at: e.at, ...(e.kind === "user" && e.groupId ? { groupId: e.groupId } : {}), ...(e.kind === "user" && e.group ? { group: e.group } : {}) };
    }
  }
  return null;
}

export interface ChatAppOptions {
  walletServiceUrl: string;
  llm: LlmConfig;
  roster: AgentSpec[];
  /** Persist conversations here (one JSON file per agent). */
  dataDir?: string;
  /** Links shown in the page header. */
  links?: { dashboard?: string; board?: string; explorer?: string };
  blockedUrls?: string[];
  walletPollMs?: number;
  approvalWaitMs?: number;
  maxSteps?: number;
  fetch?: typeof fetch;
  /** Broadcast groups file (default: in memory). */
  groupsFile?: string;
  /** Where registered agents' tokens are persisted (DATA_DIR/agent-tokens.json). */
  tokensFile?: string;
  /** Origins allowed to register agents cross-origin (the owner's dashboard). */
  corsOrigins?: string[];
  /**
   * The scheduler's internal token (DATA_DIR/scheduler-token.json). Only a message carrying it as
   * X-Scheduler-Token may say `source: "scheduler"`. A function is read on every such message, so the
   * scheduler can create the file after this server started. Unset: scheduled messages are refused.
   */
  schedulerToken?: string | (() => string | undefined);
}

/** DATA_DIR/scheduler-token.json, written by the scheduler on its first start (mode 0600). */
export function readSchedulerToken(dataDir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(resolve(dataDir, "scheduler-token.json"), "utf8")) as { schedulerToken?: unknown };
    return typeof j.schedulerToken === "string" && j.schedulerToken ? j.schedulerToken : undefined;
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** One line of plain text from the scheduler: no control characters, no markup, bounded. */
function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export interface ChatApp {
  app: express.Express;
  agents: Map<string, ChatAgent>;
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createChatApp(opts: ChatAppOptions): ChatApp {
  const doFetch = opts.fetch ?? fetch;
  const clients = new Set<Response>();
  const wallets = new Map<string, WalletView>();
  const services = new Map<string, ServiceChip[]>();
  const agents = new Map<string, ChatAgent>();

  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  const onEvent = (e: AgentEvent) => {
    broadcast(e.type, e);
    if (e.type === "run.finished" || (e.type === "log.update" && e.entry.kind === "tool")) void refreshWallet(e.agent);
  };

  const makeAgent = (spec: AgentSpec) =>
      new ChatAgent({
        name: spec.name,
        role: spec.role,
        token: spec.token,
        walletServiceUrl: opts.walletServiceUrl,
        llm: opts.llm,
        onEvent,
        dataDir: opts.dataDir,
        blockedUrls: opts.blockedUrls,
        approvalWaitMs: opts.approvalWaitMs,
        maxSteps: opts.maxSteps,
      });
  for (const spec of opts.roster) agents.set(spec.name, makeAgent(spec));
  const tokens = new Map(opts.roster.map((s) => [s.name, s.token]));
  const groupStore = new GroupStore(opts.groupsFile, () => defaultGroups([...agents.keys()]));

  async function refreshWallet(name: string): Promise<void> {
    const token = tokens.get(name);
    if (!token) return;
    let view: WalletView;
    // Keep the last known chips when the wallet is unreachable (stale beats flicker).
    let chips = services.get(name) ?? [];
    try {
      const res = await doFetch(`${opts.walletServiceUrl}/v1/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        view = { error: res.status === 401 ? "token rejected (run npm run setup)" : `wallet error ${res.status}` };
      } else {
        const me = (await res.json()) as { agent: WalletView & { address: string; services?: Array<Partial<ServiceChip> & { kind?: string }> }; limits: WalletView["limits"]; bank?: unknown };
        chips = (Array.isArray(me.agent.services) ? me.agent.services : [])
          .filter((x) => x && x.id && x.kind !== "directory")
          .map((x) => ({
            id: String(x.id),
            name: x.name ?? String(x.id),
            icon: x.icon ?? "",
            color: x.color ?? "",
            ...(x.pricing ? { pricing: String(x.pricing) } : {}),
            ...(x.maxPrice ? { maxPrice: String(x.maxPrice) } : {}),
            ...(x.shopify && typeof x.shopify === "object" ? { shopify: shopifyRef(x.shopify) } : {}),
          }));
        view = {
          address: me.agent.address,
          balance: me.agent.balance,
          spentToday: me.agent.spentToday,
          earnedToday: me.agent.earnedToday,
          frozen: me.agent.frozen,
          frozenReason: me.agent.frozenReason,
          limits: me.limits,
        };
        const bank = bankRef(me.bank);
        if (bank) view.bank = bank;
      }
    } catch {
      view = { error: "wallet service offline" };
    }
    const prev = JSON.stringify([wallets.get(name), services.get(name)]);
    wallets.set(name, view);
    services.set(name, chips);
    if (prev !== JSON.stringify([view, chips])) broadcast("wallet", { agent: name, wallet: view, services: chips });
  }
  const refreshAll = () => Promise.all([...agents.keys()].map(refreshWallet));
  const poll = setInterval(() => void refreshAll(), opts.walletPollMs ?? 3000);
  poll.unref();

  const ready = (async () => {
    await refreshAll();
    for (const a of agents.values()) {
      await a.init().catch((err: Error) => console.warn(`[agent-chat] ${a.name}: tool init failed: ${err.message}`));
    }
  })();

  const summary = (a: ChatAgent): AgentSummary => ({
    name: a.name,
    role: a.role,
    status: a.status,
    busy: a.busy,
    wallet: wallets.get(a.name) ?? {},
    avatar: avatarFor(a.name),
    services: services.get(a.name) ?? [],
    lastMessage: lastMessageOf(a.log),
  });
  /** Compat map (id -> members) plus the rich list. Members are filtered to agents this server hosts. */
  const groupList = () => groupStore.list().map((g) => ({ ...g, members: g.members.filter((m) => agents.has(m)) }));
  const groups = () => Object.fromEntries(groupList().map((g) => [g.id, g.members]));
  const announceGroups = () => broadcast("groups", { groups: groups(), groupList: groupList() });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/static/fonts", express.static(fontsDir, { maxAge: "30d", immutable: true }));
  app.use("/static", express.static(staticDir, { maxAge: 0 }));

  app.get("/", (_req, res) => {
    res.type("html").send(
      renderChatPage({
        model: opts.llm.model,
        endpoint: hostOf(opts.llm.baseUrl),
        llmConfigured: Boolean(opts.llm.apiKey) || !/nrp-nautilus\.io/.test(opts.llm.baseUrl),
        links: opts.links ?? {},
      }),
    );
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, model: opts.llm.model, endpoint: opts.llm.baseUrl, llmKeySet: Boolean(opts.llm.apiKey), agents: agents.size });
  });

  // ---- registering a new agent ------------------------------------------------------------
  // The owner creates agents in the wallet (owner key, dashboard). The dashboard then hands the new
  // agent's token to this server, the same way Claude Desktop is given a token. We verify the token
  // with the wallet before hosting the agent.
  const cors = new Set(opts.corsOrigins ?? []);
  app.use("/api/agents", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cors.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
    }
    if (req.method === "OPTIONS") return void res.status(origin && cors.has(origin) ? 204 : 403).end();
    next();
  });

  app.post("/api/agents", async (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const role = typeof req.body?.role === "string" ? req.body.role.trim().slice(0, 600) : "";
    if (!AGENT_NAME_RE.test(name) || !/^aw_[0-9a-f]{48}$/.test(token)) {
      return void res.status(400).json({ error: "invalid_request", message: "Body must be { name, token, role? } with a valid agent name and token" });
    }
    if (agents.has(name)) return void res.status(409).json({ error: "agent_exists", message: `${name} is already here` });
    let me: { agent?: { name?: string; address?: string; id?: string } };
    try {
      const r = await doFetch(`${opts.walletServiceUrl}/v1/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
      if (r.status === 401) return void res.status(400).json({ error: "invalid_token", message: "The wallet does not recognize that token" });
      if (!r.ok) return void res.status(502).json({ error: "wallet_error", message: `Wallet answered ${r.status}` });
      me = (await r.json()) as typeof me;
    } catch {
      return void res.status(503).json({ error: "wallet_unavailable", message: "The wallet service is not reachable" });
    }
    if (me.agent?.name !== name) return void res.status(400).json({ error: "invalid_token", message: "That token belongs to a different agent" });
    const spec: AgentSpec = { name, role: role || roleFor(name), token };
    const agent = makeAgent(spec);
    agents.set(name, agent);
    tokens.set(name, token);
    persistToken(name, token, me.agent?.id, me.agent?.address, role || undefined);
    await agent.init().catch((err: Error) => console.warn(`[agent-chat] ${name}: tool init failed: ${err.message}`));
    await refreshWallet(name);
    broadcast("agent.added", { agent: summary(agent) });
    console.log(`[agent-chat] hosting new agent ${name}`);
    res.status(201).json({ agent: summary(agent) });
  });

  function persistToken(name: string, token: string, agentId?: string, address?: string, role?: string): void {
    if (!opts.tokensFile) return;
    let all: Record<string, unknown> = {};
    try {
      if (existsSync(opts.tokensFile)) all = JSON.parse(readFileSync(opts.tokensFile, "utf8")) as Record<string, unknown>;
    } catch {
      /* rewrite below */
    }
    all[name] = { agentId, name, address, token, ...(role ? { role } : {}) };
    mkdirSync(dirname(opts.tokensFile), { recursive: true });
    const tmp = `${opts.tokensFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, opts.tokensFile);
  }

  app.get("/api/agents", (_req, res) => {
    res.json({ agents: [...agents.values()].map(summary), groups: groups(), groupList: groupList() });
  });

  app.get("/api/agents/:name", (req, res) => {
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    res.json({ ...summary(a), log: a.log, tools: a.toolNames() });
  });

  const sendTo = async (a: ChatAgent, text: string, groupId?: string, group?: string, scheduled?: ScheduledMeta) => {
    const { runId, done } = await a.send(text, { groupId, group, scheduled });
    void done.catch((err: Error) => console.warn(`[agent-chat] ${a.name}: ${err.message}`));
    return runId;
  };

  app.post("/api/agents/:name/messages", async (req: Request, res: Response) => {
    // §20.3: only the scheduler, with its token, may send a scheduled message. Checked first, so a
    // forged claim learns nothing (not even whether the agent exists).
    let scheduled: ScheduledMeta | undefined;
    if (req.body?.source === "scheduler") {
      const want = typeof opts.schedulerToken === "function" ? opts.schedulerToken() : opts.schedulerToken;
      const given = req.header("x-scheduler-token");
      if (!want || !given || !safeEqual(given, want)) return void res.status(403).json({ error: "forbidden", message: "Only the scheduler can send scheduled messages" });
      const scheduleId = typeof req.body.scheduleId === "string" && /^sch_[A-Za-z0-9]{1,64}$/.test(req.body.scheduleId) ? req.body.scheduleId : "";
      if (!scheduleId) return void res.status(400).json({ error: "invalid_request", message: "A scheduled message needs a scheduleId" });
      const setBy = req.body.setBy === "owner" ? "owner" : "agent";
      const context = line(req.body.context, 400);
      scheduled = { scheduleId, setBy, label: line(req.body.label, 80) || (setBy === "owner" ? "Rule your owner set" : "Reminder you set"), ...(context ? { context } : {}) };
    }
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return void res.status(400).json({ error: "invalid_request", message: "Body must be { text }" });
    try {
      res.status(202).json({ agent: a.name, runId: await sendTo(a, text, undefined, undefined, scheduled) });
    } catch (err) {
      if (err instanceof BusyError) return void res.status(409).json({ error: "agent_busy", message: err.message });
      res.status(500).json({ error: "internal_error", message: (err as Error).message });
    }
  });

  // ---- broadcast groups ------------------------------------------------------------------
  const sendGroupError = (res: Response, err: unknown) => {
    if (err instanceof GroupError) return void res.status(err.status).json({ error: err.code, message: err.message });
    res.status(500).json({ error: "internal_error", message: (err as Error).message });
  };
  app.get("/api/groups", (_req, res) => {
    res.json({ groups: groupList() });
  });
  app.post("/api/groups", (req, res) => {
    try {
      const g = groupStore.create(req.body ?? {}, new Set(agents.keys()));
      announceGroups();
      res.status(201).json({ group: g });
    } catch (err) {
      sendGroupError(res, err);
    }
  });
  app.patch("/api/groups/:id", (req, res) => {
    try {
      const g = groupStore.update(String(req.params.id), req.body ?? {}, new Set(agents.keys()));
      announceGroups();
      res.json({ group: g });
    } catch (err) {
      sendGroupError(res, err);
    }
  });
  app.delete("/api/groups/:id", (req, res) => {
    try {
      groupStore.remove(String(req.params.id));
      announceGroups();
      res.json({ ok: true });
    } catch (err) {
      sendGroupError(res, err);
    }
  });

  app.post("/api/groups/:group/messages", async (req: Request, res: Response) => {
    const def = groupList().find((g) => g.id === String(req.params.group));
    const members = def ? def.members : groupMembers(String(req.params.group), [...agents.keys()]);
    if (members.length === 0) return void res.status(404).json({ error: "group_not_found", message: `No group ${req.params.group}` });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return void res.status(400).json({ error: "invalid_request", message: "Body must be { text }" });
    // One id per broadcast: the UI renders one user bubble for the whole group thread.
    const groupId = `grp_${randomBytes(6).toString("hex")}`;
    // Fire all at once: the workers really do race each other for bounty slots.
    const runs = await Promise.all(
      members.map(async (name) => {
        try {
          return { agent: name, runId: await sendTo(agents.get(name)!, text, groupId, def?.id ?? String(req.params.group)) };
        } catch (err) {
          return { agent: name, error: (err as Error).message };
        }
      }),
    );
    res.status(202).json({ group: req.params.group, groupId, runs });
  });

  app.post("/api/agents/:name/stop", (req, res) => {
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    res.json({ stopped: a.stop() });
  });

  app.post("/api/agents/:name/reset", (req, res) => {
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    try {
      a.reset();
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: "agent_busy", message: (err as Error).message });
    }
  });

  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: [...agents.values()].map(summary), groups: groups(), groupList: groupList() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  return {
    app,
    agents,
    ready,
    async close() {
      clearInterval(poll);
      for (const res of clients) res.end();
      await Promise.all([...agents.values()].map((a) => a.close()));
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
