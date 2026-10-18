import { describe, expect, it } from "vitest";
import type { Approval, Receipt, WalletEvent } from "@allowance/shared";
import { Notifier } from "./notifier.js";
import type { BotApi } from "./notifier.js";
import { counterpartyLabel, decisionSuffix, formatEvent, helloText } from "./format.js";
import { parseSseBlock } from "./sse.js";

const PK = "0x" + "ab".repeat(32);
const ATTACKER = "0x000000000000000000000000000000000000dEaD";

function receipt(partial: Partial<Receipt>): Receipt {
  return {
    id: "rcp_1",
    kind: "spend",
    status: "settled",
    agentId: "agt_1",
    agentName: "researcher",
    description: "Acme Weather",
    amount: "0.05",
    amountBaseUnits: "50000",
    counterparty: { address: "0x9999999999999999999999999999999999999999", origin: "http://localhost:4021", name: "Acme Weather" },
    network: "eip155:84532",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function approval(partial: Partial<Approval> = {}): Approval {
  return {
    id: "apr_1",
    agentId: "agt_1",
    agentName: "shopper",
    paymentId: "pay_1",
    amount: "18.50",
    description: "Pizza",
    counterparty: { address: "0x9999999999999999999999999999999999999999", origin: "http://localhost:4021", name: "Pizza" },
    status: "pending",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function event(type: WalletEvent["type"], partial: Partial<WalletEvent> = {}): WalletEvent {
  return { id: "evt_1", type, at: new Date().toISOString(), agentId: "agt_1", agentName: "researcher", message: "", ...partial };
}

class FakeApi implements BotApi {
  sent: { chatId: string | number; text: string; buttons: string[][] }[] = [];
  edits: { chatId: string | number; messageId: number; text: string }[] = [];
  answers: { id: string; text?: string }[] = [];
  failSend = false;
  async sendMessage(chatId: string | number, text: string, other?: { reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } }) {
    if (this.failSend) throw new Error("telegram down");
    const buttons = (other?.reply_markup?.inline_keyboard ?? []).map((row) => row.map((b) => `${b.text}|${b.callback_data}`));
    this.sent.push({ chatId, text, buttons });
    return { message_id: this.sent.length };
  }
  async editMessageText(chatId: string | number, messageId: number, text: string) {
    this.edits.push({ chatId, messageId, text });
    return true;
  }
  async answerCallbackQuery(id: string, other?: { text?: string }) {
    this.answers.push({ id, text: other?.text });
    return true;
  }
}

/** Fake wallet-service: records calls, returns canned responses. */
function fakeWallet(responses: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body?: unknown; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers as Record<string, string>) ?? {} });
    const r = responses[path] ?? { status: 200, body: { approval: approval({ status: path.endsWith("approve") ? "approved" : "denied", decidedBy: "telegram" }) } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function make(responses?: Record<string, { status: number; body: unknown }>, chatId: string | null = "4242") {
  const api = new FakeApi();
  const wallet = fakeWallet(responses);
  const n = new Notifier({ walletUrl: "http://wallet.test", api, chatId: () => chatId ?? undefined, fetch: wallet.fetch, ownerApiKey: "k" });
  return { api, wallet, n };
}

describe("formatEvent", () => {
  it("approval request has amount, agent, counterparty and Approve/Deny buttons", () => {
    const m = formatEvent(event("payment.needs_approval", { agentName: "shopper", approval: approval(), receipt: receipt({ amount: "18.50", description: "Pizza", counterparty: { address: "0x1", origin: "http://localhost:4021", name: "Pizza" } }) }))!;
    expect(m.text).toContain("$18.50");
    expect(m.text).toContain("shopper");
    expect(m.text).toContain("Pizza");
    expect(m.keyboard!.inline_keyboard[0].map((b) => (b as { callback_data: string }).callback_data)).toEqual(["apr:apr_1:approve", "apr:apr_1:deny"]);
  });

  it("block alert carries the owner message and an Unfreeze button when frozen", () => {
    const text = "Blocked: tried to send $4.50 to an unknown address. Agent frozen.";
    const m = formatEvent(event("payment.blocked", { message: text, data: { frozen: true } }))!;
    expect(m.text).toContain(text);
    expect(m.keyboard!.inline_keyboard[0][0]).toMatchObject({ text: "🧊 Unfreeze", callback_data: "agt:agt_1:unfreeze" });
    const noFreeze = formatEvent(event("payment.blocked", { message: "Blocked: x", data: { frozen: false } }))!;
    expect(noFreeze.keyboard).toBeUndefined();
  });

  it("receipt lines are dollars-only with an explorer link, never a raw address", () => {
    const r = receipt({ txHash: "0xdeadbeef", explorerUrl: "http://localhost:4030/tx/0xdeadbeef", counterparty: { address: ATTACKER, name: "Acme Weather" } });
    const m = formatEvent(event("payment.settled", { receipt: r }))!;
    expect(m.text).toContain("$0.05");
    expect(m.text).toContain("Acme Weather");
    expect(m.text).toContain('href="http://localhost:4030/tx/0xdeadbeef"');
    expect(m.text).not.toContain(ATTACKER);
    expect(formatEvent(event("transfer.sent", { receipt: receipt({ kind: "transfer", description: "Transfer", counterparty: { address: ATTACKER } }) }))!.text).toContain("an address");
    expect(formatEvent(event("earning.received", { receipt: receipt({ kind: "earn", amount: "0.50", counterparty: { address: "0x1", origin: "http://localhost:4021" } }) }))!.text).toContain("localhost:4021");
    expect(formatEvent(event("topup", { receipt: receipt({ kind: "topup", amount: "20.00" }) }))!.text).toContain("$20.00");
  });

  it("failed settlement is a warning; approval decisions and unknown events send nothing", () => {
    expect(formatEvent(event("payment.settled", { message: "Payment failed (x)", receipt: receipt({ status: "failed" }) }))!.text).toContain("⚠️");
    expect(formatEvent(event("approval.approved", { approval: approval() }))).toBeNull();
    expect(formatEvent(event("policy.updated"))).toBeNull();
  });

  it("Capital One statement events: posted is quiet, failed is one short line", () => {
    const posted = receipt({ bank: { status: "posted", ref: "6532a1", account: "••5678" }, counterparty: { address: "0x1", name: "Acme Weather" } });
    expect(formatEvent(event("bank.posted", { agentName: "researcher", receipt: posted }))).toBeNull();
    const failed = receipt({ bank: { status: "failed", account: "••5678", error: "Nessie POST /accounts/x/purchases answered 500" }, counterparty: { address: "0x1", name: "Acme <Weather>" } });
    const m = formatEvent(event("bank.failed", { agentName: "researcher", message: "long message", receipt: failed }))!;
    expect(m.text).toBe("⚠️ Couldn't put researcher's <b>$0.05</b> (Acme &lt;Weather&gt;) on the Capital One statement. Retry it on the dashboard.");
    expect(m.text.split("\n")).toHaveLength(1);
    expect(m.keyboard).toBeUndefined();
    expect(formatEvent(event("bank.failed", { agentName: "shopper", receipt: receipt({ kind: "topup", amount: "20.00" }) }))!.text).toBe("⚠️ Couldn't move <b>$20.00</b> from Capital One to shopper. Retry it on the dashboard.");
  });

  it("escapes HTML and never leaks a private key field", () => {
    const m = formatEvent(event("payment.blocked", { message: "Blocked: <b>x</b> & y", data: { frozen: false, privateKey: PK } }))!;
    expect(m.text).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(m.text).not.toContain(PK);
    expect(helloText()).toContain("Approve");
    expect(counterpartyLabel(undefined)).toBe("someone");
    expect(decisionSuffix("expired")).toContain("Expired");
  });
});

describe("Notifier event → action", () => {
  it("sends approval requests and edits them when decided elsewhere", async () => {
    const { api, n } = make();
    await n.handleEvent(event("payment.needs_approval", { approval: approval(), receipt: receipt({ status: "pending_approval" }) }));
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].chatId).toBe("4242");
    expect(api.sent[0].buttons[0]).toEqual(["✅ Approve|apr:apr_1:approve", "❌ Deny|apr:apr_1:deny"]);

    await n.handleEvent(event("approval.denied", { approval: approval({ status: "denied", decidedBy: "dashboard" }) }));
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]).toMatchObject({ messageId: 1 });
    expect(api.edits[0].text).toContain("Denied");
    expect(api.edits[0].text).toContain("dashboard");
    // Second decision event for the same approval is ignored.
    await n.handleEvent(event("approval.approved", { approval: approval({ status: "approved" }) }));
    expect(api.edits).toHaveLength(1);
  });

  it("alerts once for a block that freezes (agent.frozen for the same receipt is deduped)", async () => {
    const { api, n } = make();
    const r = receipt({ status: "blocked", reason: "max_per_tx" });
    await n.handleEvent(event("payment.blocked", { message: "Blocked: tried to send $4.50 to an unknown address. Agent frozen.", receipt: r, data: { frozen: true } }));
    await n.handleEvent(event("agent.frozen", { message: "researcher frozen: ...", data: { cause: "policy_violation", receiptId: r.id } }));
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].text).toContain("$4.50");
    expect(api.sent[0].buttons[0]).toEqual(["🧊 Unfreeze|agt:agt_1:unfreeze"]);
    // A manual freeze from the dashboard is still announced.
    await n.handleEvent(event("agent.frozen", { message: "researcher frozen by owner.", data: { cause: "owner" } }));
    expect(api.sent).toHaveLength(2);
  });

  it("sends short receipt lines for settled, transfer, earning and topup", async () => {
    const { api, n } = make();
    await n.handleEvent(event("payment.settled", { receipt: receipt({ explorerUrl: "http://x/tx/1" }) }));
    await n.handleEvent(event("transfer.sent", { receipt: receipt({ kind: "transfer", amount: "1.25" }) }));
    await n.handleEvent(event("earning.received", { receipt: receipt({ kind: "earn", amount: "0.50" }) }));
    await n.handleEvent(event("topup", { receipt: receipt({ kind: "topup", amount: "20.00" }) }));
    await n.handleEvent(event("payment.signed", { receipt: receipt({ status: "signed" }) }));
    expect(api.sent.map((s) => [...s.text][0])).toEqual(["💸", "📤", "💰", "➕"]);
  });

  it("drops events when unpaired and survives Telegram failures", async () => {
    const unpaired = make(undefined, null);
    await unpaired.n.handleEvent(event("topup", { receipt: receipt({ kind: "topup" }) }));
    expect(unpaired.api.sent).toHaveLength(0);
    const { api, n } = make();
    api.failSend = true;
    await expect(n.handleEvent(event("topup", { receipt: receipt({ kind: "topup" }) }))).resolves.toBeUndefined();
  });
});

describe("Notifier button taps", () => {
  it("approve → POST approve {by:telegram}, answer, edit message", async () => {
    const { api, wallet, n } = make();
    await n.handleEvent(event("payment.needs_approval", { approval: approval(), receipt: receipt({ status: "pending_approval" }) }));
    await n.handleCallback({ id: "cb1", data: "apr:apr_1:approve", chatId: "4242", messageId: 1 });
    expect(wallet.calls).toEqual([
      expect.objectContaining({ method: "POST", path: "/v1/approvals/apr_1/approve", body: { by: "telegram" }, headers: expect.objectContaining({ "x-owner-key": "k" }) }),
    ]);
    expect(api.answers[0]).toMatchObject({ id: "cb1", text: "Approved ✅" });
    expect(api.edits[0].text).toContain("$18.50");
    expect(api.edits[0].text).toContain("Approved");
    // The later approval.approved event does not edit again.
    await n.handleEvent(event("approval.approved", { approval: approval({ status: "approved" }) }));
    expect(api.edits).toHaveLength(1);
  });

  it("deny → POST deny, message shows Denied", async () => {
    const { api, wallet, n } = make();
    await n.handleCallback({ id: "cb2", data: "apr:apr_9:deny", chatId: "4242", messageId: 7, messageText: "🔔 Approval needed" });
    expect(wallet.calls[0]).toMatchObject({ path: "/v1/approvals/apr_9/deny", body: { by: "telegram" } });
    expect(api.answers[0].text).toBe("Denied ❌");
    expect(api.edits[0]).toMatchObject({ chatId: "4242", messageId: 7 });
    expect(api.edits[0].text).toContain("Denied");
  });

  it("already-decided approval shows the wallet's message", async () => {
    const { api, n } = make({ "/v1/approvals/apr_1/approve": { status: 409, body: { error: "approval_not_pending", message: "Approval is already expired" } } });
    await n.handleCallback({ id: "cb3", data: "apr:apr_1:approve", chatId: "4242", messageId: 1 });
    expect(api.answers[0].text).toBe("Approval is already expired");
  });

  it("unfreeze → POST unfreeze, message edited", async () => {
    const { api, wallet, n } = make({ "/v1/agents/agt_1/unfreeze": { status: 200, body: { agent: { name: "researcher", frozen: false } } } });
    await n.handleCallback({ id: "cb4", data: "agt:agt_1:unfreeze", chatId: "4242", messageId: 3, messageText: "🛑 Blocked" });
    expect(wallet.calls[0]).toMatchObject({ method: "POST", path: "/v1/agents/agt_1/unfreeze" });
    expect(api.answers[0].text).toBe("researcher unfrozen");
    expect(api.edits[0].text).toContain("Unfrozen");
  });

  it("wallet unreachable → friendly alert, no crash", async () => {
    const api = new FakeApi();
    const n = new Notifier({ walletUrl: "http://127.0.0.1:1", api, chatId: () => "4242" });
    await expect(n.handleCallback({ id: "cb5", data: "apr:apr_1:approve" })).resolves.toBeUndefined();
    expect(api.answers[0].text).toContain("dashboard");
    await n.handleCallback({ id: "cb6", data: "wat:1:2" });
    expect(api.answers[1].text).toBe("Unknown button");
  });
});

const PIZZA_GRANT = {
  id: "acme-pizza",
  name: "Acme Pizza",
  provider: "Acme APIs",
  icon: "🍕",
  color: "#E5523A",
  kind: "x402" as const,
  summary: "Order a pizza for $18.50; fulfillment is simulated.",
  baseUrl: "http://localhost:4021/pizza",
  pricing: "$18.50 per order",
  maxPrice: "18.50",
  permissions: ["Pay up to $18.50 per order to Acme Pizza", "Place orders on your behalf"],
  source: "directory" as const,
};

function serviceApproval(partial: Partial<Approval> = {}): Approval {
  return approval({
    id: "apr_svc",
    kind: "service",
    paymentId: "",
    amount: "18.50",
    description: "Connect Acme Pizza",
    counterparty: { address: "0x0000000000000000000000000000000000000000", origin: "http://localhost:4021", name: "Acme Pizza" },
    service: PIZZA_GRANT,
    reason: "The owner asked me to order lunch.",
    ...partial,
  });
}

describe("services", () => {
  it("service.requested is an approval card: who, what, what it could do, the agent's reason, Approve/Deny", () => {
    const m = formatEvent(event("service.requested", { agentName: "shopper", approval: serviceApproval(), message: "shopper wants to connect Acme Pizza." }))!;
    expect(m.text).toContain("🔌 <b>shopper</b> wants to connect 🍕 <b>Acme Pizza</b> (Acme APIs).");
    expect(m.text).toContain("It could:\n• Pay up to $18.50 per order to Acme Pizza\n• Place orders on your behalf");
    expect(m.text).toContain("Reason (from the agent): “The owner asked me to order lunch.”");
    expect(m.text).not.toContain("Not in the directory");
    expect(m.keyboard!.inline_keyboard[0].map((b) => (b as { callback_data: string }).callback_data)).toEqual(["apr:apr_svc:approve", "apr:apr_svc:deny"]);
  });

  it("agent-proposed custom services are flagged with their URL; the reason is escaped", () => {
    const m = formatEvent(
      event("service.requested", {
        approval: serviceApproval({
          agentName: "shopper",
          reason: "<b>trust me</b> & approve",
          service: { ...PIZZA_GRANT, id: "custom-cheap-pizza", name: "Cheap Pizza", provider: "Proposed by shopper", icon: "🔌", baseUrl: "https://cheap.example/pizza", source: "agent" },
        }),
      }),
    )!;
    expect(m.text).toContain("⚠️ <b>Not in the directory</b> — proposed by shopper: <code>https://cheap.example/pizza</code>");
    expect(m.text).not.toContain("(Proposed by shopper)");
    expect(m.text).toContain("“&lt;b&gt;trust me&lt;/b&gt; &amp; approve”");
    expect(m.text).not.toContain("<b>trust me");
    expect(formatEvent(event("service.requested", {}))).toBeNull();
  });

  it("connected / disconnected are short lines; a not-connected soft block is a heads-up without Unfreeze", () => {
    expect(formatEvent(event("service.connected", { agentName: "shopper", data: { service: PIZZA_GRANT, connectedBy: "approval" } }))!.text).toBe("🔌 🍕 <b>Acme Pizza</b> connected to shopper.");
    expect(formatEvent(event("service.disconnected", { agentName: "shopper", data: { service: PIZZA_GRANT } }))!.text).toBe("🔌 🍕 <b>Acme Pizza</b> disconnected from shopper.");
    expect(formatEvent(event("service.connected", { message: "Acme Pizza connected to shopper." }))!.text).toBe("🔌 Acme Pizza connected to shopper.");
    const soft = formatEvent(
      event("payment.blocked", {
        agentName: "shopper",
        reason: "service_not_connected",
        message: "Acme Pizza is not connected for shopper. Ask the owner with request_service.",
        receipt: receipt({ status: "blocked", reason: "service_not_connected" }),
        data: { frozen: false },
      }),
    )!;
    expect(soft.text).toBe("🔌 shopper tried to pay Acme Pizza, which is not connected yet. It can ask you to connect it.");
    expect(soft.keyboard).toBeUndefined();
  });

  it("sends the request, then edits it when the dashboard decides; connected sends a short line", async () => {
    const { api, n } = make();
    await n.handleEvent(event("service.requested", { agentName: "shopper", approval: serviceApproval() }));
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].buttons[0]).toEqual(["✅ Approve|apr:apr_svc:approve", "❌ Deny|apr:apr_svc:deny"]);
    await n.handleEvent(event("approval.approved", { approval: serviceApproval({ status: "approved", decidedBy: "dashboard" }) }));
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]).toMatchObject({ messageId: 1 });
    expect(api.edits[0].text).toContain("Acme Pizza");
    expect(api.edits[0].text).toContain("✅ <b>Approved</b> via dashboard");
    await n.handleEvent(event("service.connected", { agentName: "shopper", data: { service: PIZZA_GRANT, connectedBy: "approval" } }));
    expect(api.sent).toHaveLength(2);
    expect(api.sent[1].text).toContain("connected to shopper");
  });

  it("tapping Approve on a service request calls the wallet and edits the message", async () => {
    const { api, wallet, n } = make({
      "/v1/approvals/apr_svc/approve": { status: 200, body: { approval: serviceApproval({ status: "approved", decidedBy: "telegram" }) } },
    });
    await n.handleEvent(event("service.requested", { agentName: "shopper", approval: serviceApproval() }));
    await n.handleCallback({ id: "cb9", data: "apr:apr_svc:approve", chatId: "4242", messageId: 1 });
    expect(wallet.calls[0]).toMatchObject({ method: "POST", path: "/v1/approvals/apr_svc/approve", body: { by: "telegram" } });
    expect(api.answers[0].text).toBe("Approved ✅");
    expect(api.edits[0].text).toContain("wants to connect");
    expect(api.edits[0].text).toContain("Approved");
    // The approval.approved event that follows does not edit a second time.
    await n.handleEvent(event("approval.approved", { approval: serviceApproval({ status: "approved" }) }));
    expect(api.edits).toHaveLength(1);
  });

  it("an expired service request is marked expired", async () => {
    const { api, n } = make();
    await n.handleEvent(event("service.requested", { approval: serviceApproval() }));
    await n.handleEvent(event("approval.denied", { reason: "expired", approval: serviceApproval({ status: "expired", decidedBy: "auto" }) }));
    expect(api.edits[0].text).toContain("Expired");
  });
});

describe("parseSseBlock", () => {
  it("parses event/data and ignores comments", () => {
    expect(parseSseBlock(": ping")).toBeNull();
    expect(parseSseBlock("event: topup\nid: evt_1\ndata: {\"a\":1}")).toEqual({ type: "topup", data: '{"a":1}' });
    expect(parseSseBlock("data: a\ndata: b")).toEqual({ type: "message", data: "a\nb" });
  });
});

describe("Shopify store requests (§15)", () => {
  const ALLBIRDS_GRANT = {
    id: "shopify-weareallbirds",
    name: "Allbirds",
    provider: "Shopify store",
    icon: "🛍️",
    color: "#95BF47",
    kind: "x402" as const,
    category: "shopping" as const,
    summary: "Shop at Allbirds (allbirds.com): search products, build a cart, and pay up to $20.00 per order with your Allowance card.",
    baseUrl: "http://localhost:4070/shops/weareallbirds",
    pricing: "Store prices · paid with your Allowance card · up to $20.00 per order",
    maxPrice: "20.00",
    permissions: ["Browse Allbirds's catalog", "Pay up to $20.00 per order with a single-use Allowance card", "Place orders on your behalf"],
    source: "agent" as const,
    shopify: { handle: "weareallbirds", domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com", cardCheckout: true },
  };
  const shopApproval = (service: Approval["service"], reason = "The owner wants new sneakers.") =>
    serviceApproval({ agentName: "shopper", amount: service!.maxPrice, description: `Add the Shopify store ${service!.name} (allbirds.com)`, service, reason });

  it("a store the agent found: says Shopify, the storefront domain, that approving adds it, the cap and how it pays", () => {
    const m = formatEvent(event("service.requested", { agentName: "shopper", approval: shopApproval(ALLBIRDS_GRANT) }))!;
    expect(m.text).toBe(
      [
        "🛍️ <b>shopper</b> wants to add the Shopify store <b>Allbirds</b>.",
        "Store: <code>allbirds.com</code> (new: approving adds it to your directory)",
        "Per-order cap: <b>$20.00</b> · pays with a single-use Allowance card (simulated)",
        "",
        "It could:",
        "• Browse Allbirds's catalog",
        "• Pay up to $20.00 per order with a single-use Allowance card",
        "• Place orders on your behalf",
        "",
        "Reason (from the agent): “The owner wants new sneakers.”",
      ].join("\n"),
    );
    expect(m.text).not.toMatch(/Not in the directory|Mode:|myshopify|admin/);
    expect(m.keyboard!.inline_keyboard[0].map((b) => (b as { callback_data: string }).callback_data)).toEqual(["apr:apr_svc:approve", "apr:apr_svc:deny"]);
  });

  it("a listed store is 'connect'; a store without a custom domain shows its myshopify address; names and reasons are escaped", () => {
    const socks = {
      ...ALLBIRDS_GRANT,
      id: "shopify-cool-socks",
      name: "Cool <Socks> & Co",
      maxPrice: "8.00",
      pricing: "Store prices · paid with your Allowance card · up to $8.00 per order",
      permissions: ["Browse Cool <Socks> & Co's catalog", "Pay up to $8.00 per order with a single-use Allowance card", "Place orders on your behalf"],
      source: "directory" as const,
      shopify: { handle: "cool-socks", domain: "cool-socks.myshopify.com", storefrontUrl: "https://cool-socks.myshopify.com", cardCheckout: false },
    };
    const m = formatEvent(event("service.requested", { approval: shopApproval(socks, "<i>please</i>") }))!;
    expect(m.text).toContain("🛍️ <b>shopper</b> wants to connect the Shopify store <b>Cool &lt;Socks&gt; &amp; Co</b>.");
    expect(m.text).toContain("Store: <code>cool-socks.myshopify.com</code>\n");
    expect(m.text).not.toContain("approving adds it");
    expect(m.text).toContain("Per-order cap: <b>$8.00</b> · pays with a single-use Allowance card (simulated)");
    expect(m.text).toContain("“&lt;i&gt;please&lt;/i&gt;”");
    expect(m.text).not.toContain("<Socks>");
  });

  it("connected lines show the storefront domain; the card is edited like other approvals", async () => {
    expect(formatEvent(event("service.connected", { agentName: "shopper", data: { service: ALLBIRDS_GRANT, connectedBy: "approval" } }))!.text).toBe(
      "🔌 🛍️ <b>Allbirds</b> (Shopify store <code>allbirds.com</code>) connected to shopper.",
    );
    const { api, n } = make();
    await n.handleEvent(event("service.requested", { agentName: "shopper", approval: shopApproval(ALLBIRDS_GRANT) }));
    await n.handleEvent(event("approval.approved", { approval: { ...shopApproval(ALLBIRDS_GRANT), status: "approved", decidedBy: "dashboard" } }));
    expect(api.sent[0].text).toContain("wants to add the Shopify store");
    expect(api.edits.at(-1)?.text).toContain("✅ <b>Approved</b> via dashboard");
  });
});
