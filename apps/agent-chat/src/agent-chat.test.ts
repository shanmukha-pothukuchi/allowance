import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMerchantStub, startWalletStub, type MerchantStub, type WalletStub } from "@allowance/mcp/test-stubs";
import { avatarFor } from "@allowance/shared/avatars";
import { ChatAgent, sanitizeHistory, servicesBlock, systemPrompt, type AgentEvent, type LogEntry } from "./agent.js";
import { chatCompletion, LlmError, type ChatMessage } from "./llm.js";
import { bankRef, createChatApp, lastMessageOf, type AgentSummary } from "./app.js";
import { groupMembers } from "./roster.js";

// ---- stub OpenAI-compatible LLM ------------------------------------------------------------
type Body = { model: string; messages: ChatMessage[]; tools?: Array<{ function: { name: string } }>; [k: string]: unknown };
type Script = (body: Body, n: number) => { status?: number; json?: unknown; headers?: Record<string, string>; delayMs?: number };

interface LlmStub {
  url: string;
  requests: Body[];
  auth: string[];
  script: Script;
  close(): Promise<void>;
}

async function startLlmStub(): Promise<LlmStub> {
  const stub: LlmStub = { url: "", requests: [], auth: [], script: () => reply("ok"), close: async () => {} };
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.post("/v1/chat/completions", async (req, res) => {
    stub.requests.push(req.body);
    stub.auth.push(String(req.headers.authorization ?? ""));
    const out = stub.script(req.body, stub.requests.length);
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.status(out.status ?? 200).json(out.json ?? {});
  });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
const reply = (content: string, reasoning?: string) => ({ json: { choices: [{ finish_reason: "stop", message: { role: "assistant", content, reasoning_content: reasoning } }] } });
const callTool = (name: string, args: unknown, id = `call_${name}`) => ({
  json: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] } }] },
});
const lastToolResult = (b: Body) => [...b.messages].reverse().find((m) => m.role === "tool") as { content: string } | undefined;
const lastUser = (b: Body) => [...b.messages].reverse().find((m) => m.role === "user") as { content: string };

let llm: LlmStub;
let wallet: WalletStub;
let merchant: MerchantStub;

beforeAll(async () => {
  [llm, wallet, merchant] = await Promise.all([startLlmStub(), startWalletStub({ approveUpTo: 5, blockAbove: 10, autoApproveAfterMs: 200 }), startMerchantStub()]);
  wallet.merchantUrl = merchant.url;
});
afterAll(async () => {
  await Promise.all([llm.close(), wallet.close(), merchant.close()]);
});

function makeAgent(extra: Partial<ConstructorParameters<typeof ChatAgent>[0]> = {}) {
  const events: AgentEvent[] = [];
  const agent = new ChatAgent({
    name: "researcher",
    role: "You research things.",
    token: wallet.token,
    walletServiceUrl: wallet.url,
    llm: { baseUrl: llm.url, apiKey: "test-key", model: "qwen3", backoffMs: 5 },
    onEvent: (e) => events.push(e),
    approvalWaitMs: 2000,
    ...extra,
  });
  return { agent, events };
}

describe("llm client", () => {
  it("sends model, tools and the bearer key; parses tool calls and reasoning", async () => {
    llm.script = () => ({ json: { choices: [{ message: { content: "<think>hmm</think>Hello", reasoning_content: "because", tool_calls: [{ id: "c1", type: "function", function: { name: "get_wallet", arguments: "{}" } }] } }] } });
    const n = llm.requests.length;
    const r = await chatCompletion(
      { baseUrl: llm.url, apiKey: "k1", model: "qwen3", extraBody: { chat_template_kwargs: { enable_thinking: false } } },
      { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "get_wallet", parameters: { type: "object", properties: {} } } }] },
    );
    expect(r.content).toBe("Hello");
    expect(r.reasoning).toBe("because");
    expect(r.toolCalls[0].function.name).toBe("get_wallet");
    const sent = llm.requests[n];
    expect(sent.model).toBe("qwen3");
    expect(sent.tools?.[0].function.name).toBe("get_wallet");
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(llm.auth[n]).toBe("Bearer k1");
  });

  it("retries 429 and 503, then succeeds", async () => {
    llm.script = (_b, i) => (i % 3 === 1 ? { status: 429, json: { error: "slow down" }, headers: { "retry-after": "0" } } : i % 3 === 2 ? { status: 503, json: {} } : reply("finally"));
    const start = llm.requests.length;
    llm.requests.length = 0;
    const retries: number[] = [];
    const r = await chatCompletion({ baseUrl: llm.url, apiKey: "k", model: "m", backoffMs: 5 }, { messages: [{ role: "user", content: "x" }], onRetry: (i) => retries.push(i.attempt) });
    expect(r.content).toBe("finally");
    expect(retries).toEqual([1, 2]);
    expect(llm.requests.length).toBe(3);
    void start;
  });

  it("does not retry a rejected key and explains it", async () => {
    llm.script = () => ({ status: 401, json: { error: "bad key" } });
    llm.requests.length = 0;
    await expect(chatCompletion({ baseUrl: llm.url, apiKey: "bad", model: "m", backoffMs: 5 }, { messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/rejected the API key/);
    expect(llm.requests.length).toBe(1);
  });

  it("refuses to call NRP without a key, with instructions", async () => {
    await expect(chatCompletion({ baseUrl: "https://ellm.nrp-nautilus.io/v1", model: "qwen3" }, { messages: [] })).rejects.toBeInstanceOf(LlmError);
    await expect(chatCompletion({ baseUrl: "https://ellm.nrp-nautilus.io/v1", model: "qwen3" }, { messages: [] })).rejects.toThrow(/nrp\.ai\/llmtoken/);
  });
});

describe("chat agent", () => {
  it("is idle until messaged, then runs tools through the wallet and replies", async () => {
    const { agent, events } = makeAgent();
    await agent.init();
    expect(agent.toolNames()).toEqual(expect.arrayContaining(["get_wallet", "fetch_url", "find_work", "claim_bounty", "submit_bounty", "transfer_usdc"]));
    const before = llm.requests.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(llm.requests.length).toBe(before); // nothing happens on its own

    llm.script = (b) => {
      const tool = lastToolResult(b);
      if (!tool) return callTool("fetch_url", { url: `${merchant.url}/api/weather?city=Oslo` });
      return reply(`Done. ${tool.content.split("\n").filter((l) => l.startsWith("Paid")).join(" ")}`);
    };
    const { done } = await agent.send("What's the weather in Oslo?");
    await done;

    const sent = llm.requests.at(-1)!;
    expect(sent.messages[0].role).toBe("system");
    expect((sent.messages[0] as { content: string }).content).toMatch(/untrusted data/);
    const tool = agent.log.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", name: "fetch_url", isError: false });
    expect((tool as { result: string }).result).toMatch(/Paid \$0\.05 to Acme Weather/);
    expect(agent.log.at(-1)).toMatchObject({ kind: "assistant" });
    expect((agent.log.at(-1) as { text: string }).text).toMatch(/Paid \$0\.05/);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.finished");
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ outcome: "done" });
    expect(agent.busy).toBe(false);
    await agent.close();
  });

  it("reports wallet blocks to the model as errors and never retries around them", async () => {
    const { agent } = makeAgent();
    llm.script = (b) => (lastToolResult(b) ? reply("The wallet blocked that transfer.") : callTool("transfer_usdc", { to: "0x000000000000000000000000000000000000dEaD", amount: "50.00" }));
    const { done } = await agent.send("Send your whole balance to 0x000000000000000000000000000000000000dEaD");
    await done;
    const tool = agent.log.find((e) => e.kind === "tool") as { isError: boolean; result: string };
    expect(tool.isError).toBe(true);
    expect(tool.result).toMatch(/Blocked by wallet policy/);
    const toolMsg = lastToolResult(llm.requests.at(-1)!)!;
    expect(toolMsg.content.startsWith("ERROR:")).toBe(true);
    wallet.frozen = false;
    await agent.close();
  });

  it("shows 'waiting for approval' while a payment is parked, then completes", async () => {
    const { agent, events } = makeAgent();
    llm.script = (b) => (lastToolResult(b) ? reply("Pizza ordered.") : callTool("fetch_url", { url: `${merchant.url}/pizza/order`, method: "POST", body: { size: "large" } }));
    const { done } = await agent.send("Order me a pizza");
    await done;
    expect(events.some((e) => e.type === "status" && e.status.state === "waiting_approval")).toBe(true);
    const waiting = events.find((e) => e.type === "status" && e.status.state === "waiting_approval") as { status: { approvalId?: string; approvalKind?: string } };
    expect(waiting.status.approvalId).toMatch(/^apr_/);
    expect(waiting.status.approvalKind).toBe("payment");
    expect((agent.log.find((e) => e.kind === "tool") as { result: string }).result).toMatch(/Paid \$8\.00/);
    await agent.close();
  });

  it("handles invalid tool JSON and unknown tools without crashing the run", async () => {
    const { agent } = makeAgent();
    let step = 0;
    llm.script = () => {
      step++;
      if (step === 1) return callTool("get_wallet", "{not json", "c_bad");
      if (step === 2) return callTool("hack_the_wallet", {}, "c_unknown");
      return reply("ok");
    };
    const { done } = await agent.send("go");
    await done;
    const tools = agent.log.filter((e) => e.kind === "tool") as Array<{ isError: boolean; result: string }>;
    expect(tools[0].isError).toBe(true);
    expect(tools[0].result).toMatch(/not valid JSON/);
    expect(tools[1].result).toMatch(/no tool named hack_the_wallet/);
    await agent.close();
  });

  it("asks again when the model returns an empty reply", async () => {
    const { agent } = makeAgent();
    let n = 0;
    llm.script = () => (++n <= 2 ? reply("") : reply("here you go"));
    await (await agent.send("hi")).done;
    expect(agent.log.at(-1)).toMatchObject({ kind: "assistant", text: "here you go" });
    n = 0;
    llm.script = () => reply("");
    await (await agent.send("hi again")).done;
    expect(agent.log.at(-1)).toMatchObject({ kind: "error" });
    await agent.close();
  });

  it("caps runaway loops at maxSteps", async () => {
    const { agent, events } = makeAgent({ maxSteps: 3 });
    llm.script = (_b, i) => callTool("get_wallet", {}, `c${i}`);
    const { done } = await agent.send("loop forever");
    await done;
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ outcome: "step_limit" });
    expect(agent.log.at(-1)).toMatchObject({ kind: "error" });
    await agent.close();
  });

  it("refuses a second message while busy, can be stopped, and keeps context valid", async () => {
    const { agent, events } = makeAgent();
    llm.script = () => ({ ...reply("late"), delayMs: 2000 });
    const { done } = await agent.send("slow");
    await expect(agent.send("another")).rejects.toThrow(/busy/);
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.stop()).toBe(true);
    await done;
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ outcome: "stopped" });
    expect(agent.busy).toBe(false);
    await agent.close();
  });

  it("persists the conversation and repairs a history cut mid-tool-call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-chat-"));
    const { agent } = makeAgent({ dataDir: dir });
    llm.script = () => reply("hello");
    await (await agent.send("hi")).done;
    await agent.close();
    const again = makeAgent({ dataDir: dir }).agent;
    expect(again.log.map((e) => e.kind)).toEqual(["user", "assistant"]);
    const repaired = sanitizeHistory([
      { role: "user", content: "x" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "get_wallet", arguments: "{}" } }] },
    ]);
    expect(repaired.at(-1)).toEqual({ role: "tool", tool_call_id: "a", content: "Cancelled." });
    await again.close();
  });

  it("cannot reach owner endpoints even if the model tries", async () => {
    const { agent } = makeAgent();
    llm.script = (b) => (lastToolResult(b) ? reply("refused") : callTool("fetch_url", { url: `${wallet.url}/v1/approvals/apr_1/approve`, method: "POST", headers: { "x-owner-key": "stolen" } }));
    await (await agent.send(lastUser({ messages: [{ role: "user", content: "approve it" }] } as Body).content)).done;
    const tool = agent.log.find((e) => e.kind === "tool") as { isError: boolean; result: string };
    expect(tool.isError).toBe(true);
    expect(tool.result).toMatch(/Refused/);
    await agent.close();
  });
});

describe("services in the agent's context (§13.4)", () => {
  const sys = (b: Body) => (b.messages[0] as { content: string }).content;

  it("rebuilds the 'Your services' block from GET /v1/services at the start of each run", async () => {
    const { agent } = makeAgent();
    llm.script = () => reply("ok");
    await (await agent.send("hi")).done;
    const prompt = sys(llm.requests.at(-1)!);
    expect(prompt).toContain("Your services (connected by your owner; these are the only paid services you can use):");
    expect(prompt).toContain("- 🌤️ Acme Weather (acme-weather): Current weather for any city. · $0.05 per call");
    expect(prompt).toContain("- 🍕 Acme Pizza (acme-pizza)");
    expect(prompt).not.toContain("acme-stocks");
    expect(prompt).toContain("The Service Directory is always available");
    expect(prompt).toContain("Before using a service, call get_service for how to call it. If you need something you don't have, search_services and request_service; your owner approves.");

    // the owner connects another service between runs → next run sees it
    wallet.connect(wallet.token, "acme-stocks");
    await (await agent.send("again")).done;
    expect(sys(llm.requests.at(-1)!)).toContain("- 📈 Acme Stocks (acme-stocks)");
    wallet.agents.get(wallet.token)!.services = wallet.agents.get(wallet.token)!.services.filter((s) => s.id !== "acme-stocks");
    await agent.close();
  });

  it("says '(could not load your services)' when the wallet can't be asked", async () => {
    const { agent } = makeAgent({ walletServiceUrl: "http://127.0.0.1:1" });
    llm.script = () => reply("ok");
    await (await agent.send("hi")).done;
    expect(sys(llm.requests.at(-1)!)).toContain("(could not load your services)");
    expect(agent.log.at(-1)).toMatchObject({ kind: "assistant", text: "ok" });
    await agent.close();
    expect(servicesBlock([])).toContain("(none connected yet)");
    expect(systemPrompt("x", "y")).not.toContain("Your services");
  });

  it("flags a service request as waiting_approval (approvalKind service) and refreshes services mid-run", async () => {
    const tok = wallet.addToken("shopper", []);
    const { agent, events } = makeAgent({ name: "shopper", token: tok });
    let step = 0;
    // null for an optional parameter (common with open-weight models) is treated as absent
    llm.script = () => (++step === 1 ? callTool("request_service", { service_id: "acme-pizza", custom: null, reason: "Owner wants pizza" }) : reply("Acme Pizza is connected."));
    await (await agent.send("Order me a pizza")).done;
    const first = llm.requests.at(-2)!;
    const second = llm.requests.at(-1)!;
    expect(sys(first)).toContain("(none connected yet)");
    expect(sys(second)).toContain("- 🍕 Acme Pizza (acme-pizza)");
    const waiting = events.find((e) => e.type === "status" && e.status.state === "waiting_approval") as { status: { approvalId?: string; approvalKind?: string } } | undefined;
    expect(waiting?.status.approvalId).toMatch(/^apr_/);
    expect(waiting?.status.approvalKind).toBe("service");
    const tool = agent.log.find((e) => e.kind === "tool") as { name: string; result: string; isError: boolean };
    expect(tool).toMatchObject({ name: "request_service", isError: false });
    expect(tool.result).toMatch(/^Connected Acme Pizza\./);
    await agent.close();
  });

  it("lastMessageOf skips tool entries and truncates long text", () => {
    const log: LogEntry[] = [
      { kind: "user", id: "1", text: "hi", at: "t1", groupId: "grp_1" },
      { kind: "assistant", id: "2", text: "x".repeat(400), at: "t2" },
      { kind: "tool", id: "3", name: "get_wallet", args: {}, at: "t3" },
    ];
    const m = lastMessageOf(log)!;
    expect(m.kind).toBe("assistant");
    expect(m.at).toBe("t2");
    expect(m.text.length).toBe(280);
    expect(m.text.endsWith("…")).toBe(true);
    expect(lastMessageOf(log.slice(0, 1))).toEqual({ kind: "user", text: "hi", at: "t1", groupId: "grp_1" });
    expect(lastMessageOf([])).toBeNull();
  });
});

describe("broadcast groups and new agents", () => {
  it("creates, edits, sends to and deletes groups; registers a new agent after checking its token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-groups-"));
    const tokensFile = join(dir, "agent-tokens.json");
    const chat = createChatApp({
      walletServiceUrl: wallet.url,
      llm: { baseUrl: llm.url, apiKey: "k", model: "qwen3", backoffMs: 5 },
      roster: [
        { name: "worker-1", role: "w", token: wallet.token },
        { name: "worker-2", role: "w", token: wallet.token },
        { name: "researcher", role: "r", token: wallet.token },
      ],
      walletPollMs: 60_000,
      groupsFile: join(dir, "groups.json"),
      tokensFile,
      corsOrigins: ["http://localhost:4040"],
    });
    await chat.ready;
    const server: Server = await new Promise((r) => {
      const s = chat.app.listen(0, "127.0.0.1", () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const j = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      // default group
      const list = (await (await j("GET", "/api/groups")).json()) as { groups: Array<{ id: string; members: string[]; builtIn?: boolean }> };
      expect(list.groups).toEqual([expect.objectContaining({ id: "workers", members: ["worker-1", "worker-2"], builtIn: true })]);
      // create / validate / edit
      expect((await j("POST", "/api/groups", { name: "", members: ["worker-1"] })).status).toBe(400);
      expect((await j("POST", "/api/groups", { name: "Team", members: ["nobody"] })).status).toBe(400);
      const created = (await (await j("POST", "/api/groups", { name: "Research team", members: ["researcher", "worker-1"], emoji: "🧪" })).json()) as { group: { id: string; emoji: string } };
      expect(created.group).toMatchObject({ id: "research-team", emoji: "🧪" });
      const patched = (await (await j("PATCH", "/api/groups/research-team", { members: ["researcher"] })).json()) as { group: { members: string[] } };
      expect(patched.group.members).toEqual(["researcher"]);
      llm.script = () => reply("on it");
      const sent = (await (await j("POST", "/api/groups/research-team/messages", { text: "hello team" })).json()) as { runs: Array<{ agent: string }> };
      expect(sent.runs.map((r) => r.agent)).toEqual(["researcher"]);
      expect((await j("DELETE", "/api/groups/workers")).status).toBe(409);
      expect((await j("DELETE", "/api/groups/research-team")).status).toBe(200);
      const agentsRes = (await (await j("GET", "/api/agents")).json()) as { groupList: Array<{ id: string }>; groups: Record<string, string[]> };
      expect(agentsRes.groupList.map((g) => g.id)).toEqual(["workers"]);
      expect(agentsRes.groups.workers).toEqual(["worker-1", "worker-2"]);

      // register a new agent: CORS preflight from the dashboard, token checked with the wallet
      const pre = await fetch(`${base}/api/agents`, { method: "OPTIONS", headers: { origin: "http://localhost:4040", "access-control-request-method": "POST" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:4040");
      expect((await fetch(`${base}/api/agents`, { method: "OPTIONS", headers: { origin: "http://evil.example" } })).status).toBe(403);
      const newToken = wallet.addToken("travel-planner", ["acme-weather"]);
      expect((await j("POST", "/api/agents", { name: "travel-planner", token: "aw_" + "00".repeat(24) })).status).toBe(400);
      expect((await j("POST", "/api/agents", { name: "someone-else", token: newToken })).status).toBe(400);
      const reg = await j("POST", "/api/agents", { name: "travel-planner", token: newToken, role: "You plan trips." }, { origin: "http://localhost:4040" });
      expect(reg.status).toBe(201);
      expect(reg.headers.get("access-control-allow-origin")).toBe("http://localhost:4040");
      expect(((await reg.json()) as { agent: { name: string; role: string } }).agent).toMatchObject({ name: "travel-planner", role: "You plan trips." });
      expect((await j("POST", "/api/agents", { name: "travel-planner", token: newToken })).status).toBe(409);
      const saved = JSON.parse(readFileSync(tokensFile, "utf8")) as Record<string, { token: string; role?: string }>;
      expect(saved["travel-planner"]).toMatchObject({ token: newToken, role: "You plan trips." });
      // and it can be put in a group
      expect((await j("POST", "/api/groups", { name: "Planners", members: ["travel-planner"] })).status).toBe(201);
    } finally {
      await chat.close();
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe("chat server", () => {
  it("serves the page, lists agents with wallets, runs messages and group broadcasts", async () => {
    const chat = createChatApp({
      walletServiceUrl: wallet.url,
      llm: { baseUrl: llm.url, apiKey: "k", model: "qwen3", backoffMs: 5 },
      roster: [
        { name: "researcher", role: "r", token: wallet.token },
        { name: "worker-1", role: "w", token: wallet.token },
        { name: "worker-2", role: "w", token: wallet.token },
      ],
      walletPollMs: 60_000,
      approvalWaitMs: 2000,
    });
    await chat.ready;
    const server: Server = await new Promise((r) => {
      const s = chat.app.listen(0, "127.0.0.1", () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(base);
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      expect(await page.text()).toMatch(/Allowance Agents/);
      expect((await fetch(`${base}/static/chat.js`)).status).toBe(200);

      const list = (await (await fetch(`${base}/api/agents`)).json()) as { agents: Array<{ name: string; wallet: { balance?: string } }>; groups: { workers: string[] } };
      expect(list.agents.map((a) => a.name)).toEqual(["researcher", "worker-1", "worker-2"]);
      expect(list.agents[0].wallet.balance).toBeDefined();
      expect(list.groups.workers).toEqual(["worker-1", "worker-2"]);

      // collect SSE frames
      const ctrl = new AbortController();
      const frames: string[] = [];
      void fetch(`${base}/api/events`, { signal: ctrl.signal }).then(async (r) => {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) break;
          frames.push(dec.decode(value));
        }
      });
      await new Promise((r) => setTimeout(r, 100));

      llm.script = () => reply("hi there");
      const post = await fetch(`${base}/api/agents/researcher/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
      expect(post.status).toBe(202);
      for (let i = 0; i < 50 && !frames.join("").includes("run.finished"); i++) await new Promise((r) => setTimeout(r, 50));
      expect(frames.join("")).toMatch(/event: snapshot/);
      expect(frames.join("")).toMatch(/event: run\.finished/);
      const detail = (await (await fetch(`${base}/api/agents/researcher`)).json()) as { log: Array<{ kind: string; text?: string }> };
      expect(detail.log.map((e) => e.kind)).toEqual(["user", "assistant"]);

      const group = await fetch(`${base}/api/groups/workers/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "find work" }) });
      expect(group.status).toBe(202);
      expect(((await group.json()) as { runs: Array<{ agent: string; runId?: string }> }).runs.map((r) => Boolean(r.runId))).toEqual([true, true]);

      expect((await fetch(`${base}/api/agents/nobody/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status).toBe(404);
      expect((await fetch(`${base}/api/agents/researcher/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).status).toBe(400);
      ctrl.abort();
    } finally {
      await chat.close();
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("summaries carry avatar, services and lastMessage; group broadcasts share one groupId", async () => {
    const w1 = wallet.addToken("worker-1", []);
    const w2 = wallet.addToken("worker-2", ["acme-stocks"]);
    const chat = createChatApp({
      walletServiceUrl: wallet.url,
      llm: { baseUrl: llm.url, apiKey: "k", model: "qwen3", backoffMs: 5 },
      roster: [
        { name: "researcher", role: "r", token: wallet.token },
        { name: "worker-1", role: "w", token: w1 },
        { name: "worker-2", role: "w", token: w2 },
      ],
      walletPollMs: 60_000,
      approvalWaitMs: 2000,
    });
    await chat.ready;
    const server: Server = await new Promise((r) => {
      const s = chat.app.listen(0, "127.0.0.1", () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const idle = async () => {
      for (let i = 0; i < 100 && [...chat.agents.values()].some((a) => a.busy); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const ctrl = new AbortController();
    try {
      const list = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentSummary[] };
      const [researcher, worker1, worker2] = list.agents;
      expect(researcher.avatar).toEqual(avatarFor("researcher"));
      expect(researcher.avatar.emoji).toBe("🔎");
      expect(worker1.avatar).toEqual(avatarFor("worker-1"));
      expect(researcher.services).toEqual([
        expect.objectContaining({ id: "acme-weather", name: "Acme Weather", icon: "🌤️", color: "#3AA0E0", maxPrice: "0.05" }),
        expect.objectContaining({ id: "acme-pizza", name: "Acme Pizza", icon: "🍕", color: "#E5527A", maxPrice: "18.50" }),
      ]);
      expect(worker1.services).toEqual([]);
      expect(worker2.services.map((s) => s.id)).toEqual(["acme-stocks"]);
      expect(researcher.lastMessage).toBeNull();
      expect(Object.keys(researcher).sort()).toEqual(["avatar", "busy", "lastMessage", "name", "role", "services", "status", "wallet"]);

      // SSE snapshot has the same shape
      const frames: string[] = [];
      void fetch(`${base}/api/events`, { signal: ctrl.signal }).then(async (r) => {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) break;
          frames.push(dec.decode(value));
        }
      });
      for (let i = 0; i < 40 && !frames.join("").includes("snapshot"); i++) await new Promise((r) => setTimeout(r, 25));
      const snap = JSON.parse(frames.join("").split("event: snapshot\ndata: ")[1].split("\n")[0]) as { agents: AgentSummary[]; groups: { workers: string[] } };
      expect(snap.agents[0]).toMatchObject({ name: "researcher", avatar: avatarFor("researcher"), lastMessage: null });
      expect(snap.agents[0].services).toHaveLength(2);
      expect(snap.groups.workers).toEqual(["worker-1", "worker-2"]);

      // group broadcast: one groupId for every member's user entry
      llm.script = () => reply("on it");
      const g1 = await post("/api/groups/workers/messages", { text: "find work" });
      expect(g1.status).toBe(202);
      const g1body = (await g1.json()) as { group: string; groupId: string; runs: Array<{ agent: string; runId?: string }> };
      expect(g1body.group).toBe("workers");
      expect(g1body.groupId).toMatch(/^grp_[0-9a-f]+$/);
      expect(g1body.runs.map((r) => r.agent)).toEqual(["worker-1", "worker-2"]);
      await idle();
      for (const name of ["worker-1", "worker-2"]) {
        const d = (await (await fetch(`${base}/api/agents/${name}`)).json()) as AgentSummary & { log: LogEntry[]; tools: string[] };
        expect(d.log[0]).toMatchObject({ kind: "user", text: "find work", groupId: g1body.groupId });
        expect(d.lastMessage).toMatchObject({ kind: "assistant", text: "on it" });
        expect(d.avatar).toEqual(avatarFor(name));
        expect(d.tools).toContain("request_service");
      }
      const g2 = (await (await post("/api/groups/workers/messages", { text: "again" })).json()) as { groupId: string };
      expect(g2.groupId).not.toBe(g1body.groupId);
      await idle();

      // a direct message has no groupId
      expect((await post("/api/agents/researcher/messages", { text: "hello" })).status).toBe(202);
      await idle();
      const r = (await (await fetch(`${base}/api/agents/researcher`)).json()) as AgentSummary & { log: LogEntry[] };
      expect(r.log[0]).toEqual({ kind: "user", id: expect.any(String), text: "hello", at: expect.any(String) });
      expect(r.lastMessage).toEqual({ kind: "assistant", text: "on it", at: expect.any(String) });

      // services change → the wallet event carries the new chips
      wallet.connect(w1, "acme-pizza");
      expect((await post("/api/agents/worker-1/messages", { text: "anything new?" })).status).toBe(202);
      for (let i = 0; i < 80 && !/"agent":"worker-1","wallet":\{[^}]*\},"services":\[\{"id":"acme-pizza"/.test(frames.join("")); i++) await new Promise((r) => setTimeout(r, 25));
      expect(frames.join("")).toMatch(/event: wallet\ndata: \{"agent":"worker-1","wallet":\{.*\},"services":\[\{"id":"acme-pizza","name":"Acme Pizza","icon":"🍕","color":"#E5527A"[^}]*\}\]\}/);
      await idle();
    } finally {
      ctrl.abort();
      await chat.close();
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("copies the agent's Capital One account from /v1/me into wallet.bank (summary, snapshot, wallet event)", async () => {
    const plain = wallet.addToken("saver", []);
    const banked = wallet.addToken("spender", []);
    wallet.agents.get(banked)!.bank = { provider: "Capital One", account: "Allowance · spender", last4: "5678" };
    const chat = createChatApp({
      walletServiceUrl: wallet.url,
      llm: { baseUrl: llm.url, apiKey: "k", model: "qwen3", backoffMs: 5 },
      roster: [
        { name: "saver", role: "s", token: plain },
        { name: "spender", role: "s", token: banked },
      ],
      walletPollMs: 60_000,
      approvalWaitMs: 2000,
    });
    await chat.ready;
    const server: Server = await new Promise((r) => {
      const s = chat.app.listen(0, "127.0.0.1", () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ctrl = new AbortController();
    try {
      const list = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentSummary[] };
      const [saver, spender] = list.agents;
      expect(spender.wallet.bank).toEqual({ provider: "Capital One", account: "Allowance · spender", last4: "5678" });
      expect(spender.wallet.balance).toBe("20.00");
      expect(saver.wallet).not.toHaveProperty("bank");

      const frames: string[] = [];
      void fetch(`${base}/api/events`, { signal: ctrl.signal }).then(async (r) => {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) break;
          frames.push(dec.decode(value));
        }
      });
      for (let i = 0; i < 40 && !frames.join("").includes("snapshot"); i++) await new Promise((r) => setTimeout(r, 25));
      const snap = JSON.parse(frames.join("").split("event: snapshot\ndata: ")[1].split("\n")[0]) as { agents: AgentSummary[] };
      expect(snap.agents.find((a) => a.name === "spender")!.wallet.bank).toEqual({ provider: "Capital One", account: "Allowance · spender", last4: "5678" });

      // The bank links the saver's account later: the next wallet poll carries it.
      wallet.agents.get(plain)!.bank = { provider: "Capital One", account: "Allowance · saver", last4: "1234" };
      llm.script = () => reply("noted");
      expect((await fetch(`${base}/api/agents/saver/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status).toBe(202);
      const want = `"agent":"saver","wallet":`;
      for (let i = 0; i < 80 && !frames.join("").split("event: wallet\ndata: ").some((f) => f.includes(want) && f.includes(`"bank":`)); i++) await new Promise((r) => setTimeout(r, 25));
      const frame = frames.join("").split("event: wallet\ndata: ").find((f) => f.includes(want) && f.includes(`"bank":`))!;
      expect(JSON.parse(frame.split("\n")[0]).wallet.bank).toEqual({ provider: "Capital One", account: "Allowance · saver", last4: "1234" });
      for (let i = 0; i < 100 && [...chat.agents.values()].some((a) => a.busy); i++) await new Promise((r) => setTimeout(r, 25));
    } finally {
      ctrl.abort();
      await chat.close();
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("bankRef keeps plain strings and drops anything unexpected", () => {
    expect(bankRef({ provider: "Capital One", account: "Allowance · x<b>", last4: "1234", balance: "99.00" })).toEqual({ provider: "Capital One", account: "Allowance · xb", last4: "1234" });
    expect(bankRef({ provider: "Capital One", account: 5, last4: "1234" })).toEqual({ provider: "Capital One", account: "", last4: "1234" });
    expect(bankRef({ provider: "Evil Bank", account: "a", last4: "1234" })).toBeUndefined();
    expect(bankRef({ provider: "Capital One", account: "a", last4: "<img src=x>" })).toBeUndefined();
    expect(bankRef({ provider: "Capital One", account: "a", last4: 1234 })).toBeUndefined();
    expect(bankRef(null)).toBeUndefined();
    expect(bankRef("Capital One")).toBeUndefined();
  });

  it("groups only include workers", () => {
    expect(groupMembers("workers", ["researcher", "worker-1", "shopper", "worker-2"])).toEqual(["worker-1", "worker-2"]);
    expect(groupMembers("nope", ["worker-1"])).toEqual([]);
  });
});
