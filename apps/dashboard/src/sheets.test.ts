import { describe, expect, it, vi } from "vitest";
import { AGENT_NAME_RE as SHARED_NAME_RE, MAX_TOPUP as SHARED_MAX_TOPUP } from "@allowance/shared";
import {
  AGENT_NAME_RE,
  MAX_TOPUP,
  agentCreatedMessage,
  amountInput,
  chatLinkFor,
  chatOrigins,
  chatUrlFrom,
  checkLimits,
  checkName,
  createAgentBody,
  embedSheet,
  LIMIT_PRESETS,
  limitsLine,
  limitsMeaning,
  moneyAddedMessage,
  NAME_RULE,
  normalizeNameInput,
  parseAmount,
  originOf,
  pickTarget,
  policyFromLimits,
  postTargets,
  presetLimits,
  presetOf,
  registerWithChat,
  sheetCloseMessage,
  sheetFromSearch,
  sheetSizeMessage,
  shortMoney,
  withSheet,
} from "./sheets";

describe("agent names", () => {
  it("uses the shared contract's rule (§14.1)", () => {
    expect(AGENT_NAME_RE.source).toBe(SHARED_NAME_RE.source);
    expect(MAX_TOPUP).toBe(SHARED_MAX_TOPUP);
  });

  it("explains the rule in plain words and says when a name is free", () => {
    expect(checkName("")).toEqual({ ok: false, empty: true, message: NAME_RULE });
    expect(checkName("travel-planner", ["researcher"])).toEqual({ ok: true, message: "travel-planner is available." });
    expect(checkName("a1")).toMatchObject({ ok: true });
  });

  it("names the actual problem", () => {
    expect(checkName("Travel")).toMatchObject({ ok: false, message: "Use lowercase letters only." });
    expect(checkName("travel planner")).toMatchObject({ ok: false, message: expect.stringMatching(/No spaces/) });
    expect(checkName("travel_planner")).toMatchObject({ ok: false, message: expect.stringMatching(/Only letters, numbers and dashes/) });
    expect(checkName("-travel")).toMatchObject({ ok: false, message: expect.stringMatching(/not a dash/) });
    expect(checkName("t")).toMatchObject({ ok: false, message: "At least 2 characters." });
    expect(checkName("a".repeat(33))).toMatchObject({ ok: false, message: "At most 32 characters (this is 33)." });
    expect(checkName("researcher", ["claude-desktop", "researcher"])).toMatchObject({ ok: false, message: "researcher is taken. Pick another name." });
  });

  it("agrees with AGENT_NAME_RE on every input", () => {
    const samples = ["ab", "a-", "a--b", "0agent", "-ab", "ab-", "worker-12", "a".repeat(32), "a".repeat(33), "ä-b", "a.b", "a b", "AB", "", "x"];
    for (const s of samples) expect(checkName(s).ok, s).toBe(AGENT_NAME_RE.test(s));
  });

  it("normalizes typing: lowercase, spaces and underscores to dashes", () => {
    expect(normalizeNameInput("Travel Planner")).toBe("travel-planner");
    expect(normalizeNameInput("my_agent  2")).toBe("my-agent-2");
    expect(normalizeNameInput("ok!")).toBe("ok!"); // left for the check to flag
  });
});

describe("limits presets → policy", () => {
  it("has the owner's presets with visible numbers", () => {
    expect(LIMIT_PRESETS.map((p) => [p.label, limitsLine(p.limits)])).toEqual([
      ["Careful", "$1 per payment · $5 a day · ask above $1"],
      ["Everyday", "$5 per payment · $25 a day · ask above $5"],
      ["Shopper", "$20 per payment · $50 a day · ask above $10"],
    ]);
  });

  it("maps numbers back to a preset, or custom", () => {
    expect(presetOf(presetLimits("careful"))).toBe("careful");
    expect(presetOf({ maxPerTx: "20", dailyCap: "50.0", approvalThreshold: "10.00" })).toBe("shopper");
    expect(presetOf({ maxPerTx: "20.00", dailyCap: "60.00", approvalThreshold: "10.00" })).toBe("custom");
  });

  it("builds the policy with an empty allowlist so services govern payments (§14.3)", () => {
    expect(policyFromLimits(presetLimits("shopper"))).toEqual({ maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: { addresses: [], origins: [] } });
  });

  it("builds the POST /v1/agents body: no directory id, no duplicates, no zero starting money", () => {
    expect(createAgentBody({ name: "travel-planner", limits: presetLimits("everyday"), initialBalance: "20.00", services: ["acme-weather", "directory", "acme-weather", "acme-pizza"] })).toEqual({
      name: "travel-planner",
      policy: { maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "5.00", allowlist: { addresses: [], origins: [] } },
      initialBalance: "20.00",
      services: ["acme-weather", "acme-pizza"],
    });
    expect(createAgentBody({ name: "x2", limits: presetLimits("careful"), initialBalance: "0.00", services: [] })).not.toHaveProperty("initialBalance");
    expect(createAgentBody({ name: "x2", limits: presetLimits("careful"), services: [] })).not.toHaveProperty("initialBalance");
  });

  it("validates edited numbers", () => {
    expect(checkLimits({ maxPerTx: "5", dailyCap: "25", approvalThreshold: "0" })).toEqual({ ok: true, limits: { maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "0.00" } });
    const bad = checkLimits({ maxPerTx: "0", dailyCap: "abc", approvalThreshold: "" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["approvalThreshold", "dailyCap", "maxPerTx"]);
    const low = checkLimits({ maxPerTx: "20", dailyCap: "10", approvalThreshold: "5" });
    expect(low).toEqual({ ok: false, errors: { dailyCap: "Can't be less than one payment." } });
    expect(checkLimits({ maxPerTx: "20000", dailyCap: "25", approvalThreshold: "5" }).ok).toBe(false);
  });

  it("says what the limits mean", () => {
    expect(limitsMeaning(presetLimits("shopper"))).toBe("Pays up to $10 on its own. Up to $20 waits for your OK. Never more than $50 a day.");
    expect(limitsMeaning(presetLimits("careful"))).toBe("Pays up to $1 at a time on its own, $5 a day. Anything bigger is blocked.");
    expect(limitsMeaning({ maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "0.00" })).toMatch(/^Every payment waits for your OK/);
  });
});

describe("amounts", () => {
  it("parses what the owner types into a wire dollar string", () => {
    expect(parseAmount("20")).toEqual({ ok: true, amount: "20.00", cents: 2000 });
    expect(parseAmount(" $12.5 ")).toEqual({ ok: true, amount: "12.50", cents: 1250 });
    expect(parseAmount("1,000")).toEqual({ ok: true, amount: "1000.00", cents: 100000 });
    expect(parseAmount(".5")).toEqual({ ok: true, amount: "0.50", cents: 50 });
    expect(parseAmount("0.01")).toMatchObject({ ok: true, amount: "0.01" });
  });

  it("enforces $0.01 to $1000 for top-ups (§14.2) and says why", () => {
    expect(parseAmount("")).toMatchObject({ ok: false, empty: true });
    expect(parseAmount("0")).toMatchObject({ ok: false, message: "At least $0.01." });
    expect(parseAmount("1000.01")).toMatchObject({ ok: false, message: "At most $1,000.00 at a time." });
    expect(parseAmount("5000")).toMatchObject({ ok: false });
    expect(parseAmount("-5")).toMatchObject({ ok: false, message: "Enter an amount like 20 or 12.50." });
    expect(parseAmount("abc")).toMatchObject({ ok: false });
    expect(parseAmount("1.234")).toMatchObject({ ok: false, message: "Use at most 2 decimals (cents)." });
    expect(parseAmount("1e3")).toMatchObject({ ok: false });
  });

  it("allows $0 starting money when asked", () => {
    expect(parseAmount("0", { min: "0" })).toEqual({ ok: true, amount: "0.00", cents: 0 });
  });

  it("labels chips without .00", () => {
    expect(shortMoney("20.00")).toBe("$20");
    expect(shortMoney("12.50")).toBe("$12.50");
    expect(shortMoney("1000.00")).toBe("$1,000");
    expect(amountInput("1000.00")).toBe("1000");
    expect(amountInput("0.50")).toBe("0.50");
  });
});

describe("sheet URLs", () => {
  it("parses ?sheet= and the embed flag", () => {
    expect(sheetFromSearch("?sheet=new-agent")).toEqual({ sheet: "new-agent" });
    expect(sheetFromSearch("?sheet=add-money&agent=researcher")).toEqual({ sheet: "add-money", agent: "researcher" });
    expect(sheetFromSearch("?sheet=add-money")).toEqual({ sheet: "add-money" });
    expect(sheetFromSearch("?sheet=nope")).toBeNull();
    expect(sheetFromSearch("")).toBeNull();
    expect(embedSheet("?sheet=new-agent&embed=1&theme=dark")).toEqual({ sheet: "new-agent" });
    expect(embedSheet("?sheet=new-agent")).toBeNull(); // the dashboard opens it as a sheet instead
  });

  it("opens Add a Shopify store on the dashboard only, never as a chat embed", () => {
    expect(sheetFromSearch("?mock=1&sheet=add-shopify")).toEqual({ sheet: "add-shopify" });
    expect(embedSheet("?sheet=add-shopify&embed=1")).toBeNull();
    expect(withSheet("?mock=1", { sheet: "add-shopify" })).toBe("?mock=1&sheet=add-shopify");
    expect(withSheet("?mock=1&sheet=add-shopify", null)).toBe("?mock=1");
  });

  it("sets and clears the sheet params, keeping the others", () => {
    expect(withSheet("?mock=1", { sheet: "add-money", agent: "shopper" })).toBe("?mock=1&sheet=add-money&agent=shopper");
    expect(withSheet("?mock=1&sheet=add-money&agent=shopper", null)).toBe("?mock=1");
    expect(withSheet("?sheet=add-money&agent=shopper", { sheet: "new-agent" })).toBe("?sheet=new-agent");
    expect(withSheet("?sheet=new-agent", null)).toBe("");
  });

  it("reads the chat URL from VITE_AGENT_CHAT_URL, defaulting to :4050", () => {
    expect(chatUrlFrom({})).toBe("http://localhost:4050");
    expect(chatUrlFrom({ VITE_AGENT_CHAT_URL: "http://127.0.0.1:5050/" })).toBe("http://127.0.0.1:5050");
    expect(chatUrlFrom({ VITE_AGENT_CHAT_URL: "javascript:alert(1)" })).toBe("http://localhost:4050");
    expect(chatLinkFor("http://localhost:4050", "travel-planner")).toBe("http://localhost:4050/?agent=travel-planner");
  });
});

describe("embed messages (§14.3)", () => {
  it("builds exactly the contract's shapes", () => {
    expect(sheetSizeMessage("new-agent", 512.3)).toEqual({ type: "allowance:sheet-size", sheet: "new-agent", height: 513 });
    expect(agentCreatedMessage("travel-planner")).toEqual({ type: "allowance:agent-created", name: "travel-planner" });
    expect(moneyAddedMessage("shopper", "20.00")).toEqual({ type: "allowance:money-added", name: "shopper", amount: "20.00" });
    expect(sheetCloseMessage("add-money")).toEqual({ type: "allowance:sheet-close", sheet: "add-money" });
  });

  it("carries only the contract's fields (no room for a token)", () => {
    expect(Object.keys(agentCreatedMessage("x"))).toEqual(["type", "name"]);
    expect(Object.keys(moneyAddedMessage("x", "1.00"))).toEqual(["type", "name", "amount"]);
    expect(Object.keys(sheetSizeMessage("new-agent", 1))).toEqual(["type", "sheet", "height"]);
    expect(Object.keys(sheetCloseMessage("new-agent"))).toEqual(["type", "sheet"]);
  });

  it("targets the chat origin (both host spellings) and the dashboard itself, never *", () => {
    expect(chatOrigins("http://localhost:4050")).toEqual(["http://localhost:4050", "http://127.0.0.1:4050"]);
    expect(chatOrigins("http://127.0.0.1:4050/")).toEqual(["http://127.0.0.1:4050", "http://localhost:4050"]);
    expect(chatOrigins("https://chat.example.com")).toEqual(["https://chat.example.com"]);
    expect(postTargets("http://localhost:4050", "http://localhost:4040")).toEqual(["http://localhost:4050", "http://127.0.0.1:4050", "http://localhost:4040"]);
    expect(postTargets("http://localhost:4050")).not.toContain("*");
  });

  it("posts to the parent's real origin when allowed (ancestorOrigins, then referrer), else the chat origin", () => {
    const chat = "http://localhost:4050";
    const allowed = postTargets(chat, "http://localhost:4040");
    // the chat opened as 127.0.0.1: its iframe's referrer (referrerpolicy="origin") says so
    expect(pickTarget(allowed, chat, [null, "http://127.0.0.1:4050/"])).toBe("http://127.0.0.1:4050");
    expect(pickTarget(allowed, chat, ["http://127.0.0.1:4050", ""])).toBe("http://127.0.0.1:4050");
    expect(pickTarget(allowed, chat, [undefined, "http://localhost:4050/?agent=shopper"])).toBe("http://localhost:4050");
    // no hint (referrer stripped): the configured chat origin
    expect(pickTarget(allowed, chat, [null, ""])).toBe("http://localhost:4050");
    // a stranger is never targeted; the chat origin is, which the browser won't deliver to it
    expect(pickTarget(allowed, chat, ["https://evil.example", "https://evil.example/page"])).toBe("http://localhost:4050");
    expect(pickTarget(allowed, "http://127.0.0.1:5050", [null, ""])).toBe("http://127.0.0.1:5050");
    expect(originOf("not a url")).toBeNull();
  });
});

describe("registerWithChat", () => {
  const body = { name: "travel-planner", token: "aw_" + "b".repeat(48), role: "Plans trips." };
  const reply = (status: number, json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));

  it("POSTs { name, token, role } to {chat}/api/agents", async () => {
    const f = reply(201, { agent: { name: "travel-planner" } });
    expect(await registerWithChat("http://localhost:4050", body, f as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4050/api/agents");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("omits an empty role", async () => {
    const f = reply(201, {});
    await registerWithChat("http://localhost:4050", { name: "a1", token: body.token }, f as unknown as typeof fetch);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ name: "a1", token: body.token });
  });

  it("explains each failure in owner words", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await registerWithChat("http://localhost:4050", body, down as unknown as typeof fetch)).toEqual({ ok: false, reason: "The chat server at localhost:4050 is not reachable." });
    expect(await registerWithChat("http://localhost:4050", body, reply(409, { error: "agent_exists" }) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "The chat server already has an agent named travel-planner.",
    });
    expect(await registerWithChat("http://localhost:4050", body, reply(400, { error: "invalid_token" }) as unknown as typeof fetch)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not verify/) });
    expect(await registerWithChat("http://localhost:4050", body, reply(503, { error: "wallet_unavailable" }) as unknown as typeof fetch)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not reach the wallet/) });
    const failure = await registerWithChat("http://localhost:4050", body, reply(500, { error: "boom", message: "Boom" }) as unknown as typeof fetch);
    expect(failure).toEqual({ ok: false, reason: "The chat server said: Boom" });
    expect(JSON.stringify(failure)).not.toContain(body.token);
  });
});
