/**
 * HTTP + SSE server for the chat agents (default http://localhost:4050).
 *
 * This is an agent-side process: it holds agent tokens (like Claude Desktop does) and never the
 * owner key. Owner actions (approve, unfreeze) stay on Telegram and the dashboard.
 */
import express, { type Request, type Response } from "express";
import { ChatAgent, BusyError, type AgentEvent } from "./agent.js";
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
    try {
      const res = await doFetch(`${opts.walletServiceUrl}/v1/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        view = { error: res.status === 401 ? "token rejected (run npm run setup)" : `wallet error ${res.status}` };
      } else {
        const me = (await res.json()) as { agent: WalletView & { address: string }; limits: WalletView["limits"] };
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
    const prev = JSON.stringify(wallets.get(name));
    wallets.set(name, view);
    if (prev !== JSON.stringify(view)) broadcast("wallet", { agent: name, wallet: view });
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

  const summary = (a: ChatAgent) => ({ name: a.name, role: a.role, status: a.status, busy: a.busy, wallet: wallets.get(a.name) ?? {} });

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
    res.json({ agents: [...agents.values()].map(summary), groups: { workers: groupMembers("workers", [...agents.keys()]) } });
  });

  app.get("/api/agents/:name", (req, res) => {
    const a = agents.get(String(req.params.name));
    if (!a) return void res.status(404).json({ error: "agent_not_found", message: `No agent ${req.params.name}` });
    res.json({ ...summary(a), log: a.log, tools: a.toolNames() });
  });

  const sendTo = async (a: ChatAgent, text: string) => {
    const { runId, done } = await a.send(text);
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
    // Fire all at once: the workers really do race each other for bounty slots.
    const runs = await Promise.all(
      members.map(async (name) => {
        try {
          return { agent: name, runId: await sendTo(agents.get(name)!, text) };
        } catch (err) {
          return { agent: name, error: (err as Error).message };
        }
      }),
    );
    res.status(202).json({ group: req.params.group, runs });
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
    res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: [...agents.values()].map(summary) })}\n\n`);
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
