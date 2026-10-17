import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMerchantStub, startWalletStub, type MerchantStub, type WalletStub } from "@allowance/mcp/test-stubs";
import { ChatAgent, sanitizeHistory, type AgentEvent } from "./agent.js";
import { chatCompletion, LlmError, type ChatMessage } from "./llm.js";
import { createChatApp } from "./app.js";
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

  it("groups only include workers", () => {
    expect(groupMembers("workers", ["researcher", "worker-1", "shopper", "worker-2"])).toEqual(["worker-1", "worker-2"]);
    expect(groupMembers("nope", ["worker-1"])).toEqual([]);
  });
});
