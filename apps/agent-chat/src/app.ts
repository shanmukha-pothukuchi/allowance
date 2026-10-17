/**
 * HTTP + SSE server for the chat agents (default http://localhost:4050).
 *
 * This is an agent-side process: it holds agent tokens (like Claude Desktop does) and never the
 * owner key. Owner actions (approve, unfreeze) stay on Telegram and the dashboard.
 */
import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { avatarFor, type Avatar } from "@allowance/shared/avatars";
import { ChatAgent, BusyError, type AgentEvent, type LogEntry } from "./agent.js";
import { groupMembers, type AgentSpec } from "./roster.js";
import type { LlmConfig } from "./llm.js";
import { renderChatPage, staticDir } from "./ui.js";

export interface WalletView {
  address?: string;
  balance?: string;
  spentToday?: string;
  earnedToday?: string;
  frozen?: boolean;
  frozenReason?: string;
  limits?: { maxPerTx: string; dailyCap: string; approvalThreshold: string; remainingToday: string };
  error?: string;
}

/** A connected service as shown on the agent's chips (from the /v1/me poll). */
export interface ServiceChip {
  id: string;
  name: string;
  icon: string;
  color: string;
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
      return { kind: e.kind, text, at: e.at, ...(e.kind === "user" && e.groupId ? { groupId: e.groupId } : {}) };
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

  for (const spec of opts.roster) {
    agents.set(
      spec.name,
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
      }),
    );
  }
  const tokens = new Map(opts.roster.map((s) => [s.name, s.token]));

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
        const me = (await res.json()) as { agent: WalletView & { address: string; services?: Array<Partial<ServiceChip> & { kind?: string }> }; limits: WalletView["limits"] };
        chips = (Array.isArray(me.agent.services) ? me.agent.services : [])
          .filter((x) => x && x.id && x.kind !== "directory")
          .map((x) => ({ id: String(x.id), name: x.name ?? String(x.id), icon: x.icon ?? "", color: x.color ?? "" }));
        view = {
          address: me.agent.address,
          balance: me.agent.balance,
          spentToday: me.agent.spentToday,
          earnedToday: me.agent.earnedToday,
          frozen: me.agent.frozen,
          frozenReason: me.agent.frozenReason,
          limits: me.limits,
        };
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
  const groups = () => ({ workers: groupMembers("workers", [...agents.keys()]) });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
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

  app.get("/api/agents", (_req, res) => {
    res.json({ agents: [...agents.values()].map(summary), groups: groups() });
  });

  app.get("/api/agents/:name", (req, res) => {
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    res.json({ ...summary(a), log: a.log, tools: a.toolNames() });
  });

  const sendTo = async (a: ChatAgent, text: string, groupId?: string) => {
    const { runId, done } = await a.send(text, { groupId });
    void done.catch((err: Error) => console.warn(`[agent-chat] ${a.name}: ${err.message}`));
    return runId;
  };

  app.post("/api/agents/:name/messages", async (req: Request, res: Response) => {
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return void res.status(400).json({ error: "invalid_request", message: "Body must be { text }" });
    try {
      res.status(202).json({ agent: a.name, runId: await sendTo(a, text) });
    } catch (err) {
      if (err instanceof BusyError) return void res.status(409).json({ error: "agent_busy", message: err.message });
      res.status(500).json({ error: "internal_error", message: (err as Error).message });
    }
  });

  app.post("/api/groups/:group/messages", async (req: Request, res: Response) => {
    const members = groupMembers(String(req.params.group), [...agents.keys()]);
    if (members.length === 0) return void res.status(404).json({ error: "group_not_found", message: `No group ${req.params.group}` });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return void res.status(400).json({ error: "invalid_request", message: "Body must be { text }" });
    // One id per broadcast: the UI renders one user bubble for the whole group thread.
    const groupId = `grp_${randomBytes(6).toString("hex")}`;
    // Fire all at once: the workers really do race each other for bounty slots.
    const runs = await Promise.all(
      members.map(async (name) => {
        try {
          return { agent: name, runId: await sendTo(agents.get(name)!, text, groupId) };
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
    res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: [...agents.values()].map(summary), groups: groups() })}\n\n`);
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
