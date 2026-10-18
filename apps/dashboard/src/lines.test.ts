import { describe, expect, it } from "vitest";
import { activityLine, approvalTitle, capMeta, capUnit, eventAmount, lineText, permissionsLine, pricingBeyondCap, receiptAmount, receiptLine, shortAgo } from "./lines";
import type { Approval, Receipt, ServiceGrant } from "./types";

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  id: "rcp_1",
  kind: "spend",
  status: "settled",
  agentId: "agt_1",
  agentName: "researcher",
  description: "Quantcomm Flood Research",
  amount: "0.05",
  amountBaseUnits: "50000",
  counterparty: { address: "0x0000000000000000000000000000000000000001", name: "Quantcomm Flood Research" },
  network: "eip155:84532",
  createdAt: "2026-10-18T08:00:00Z",
  ...over,
} as Receipt);

const grant: ServiceGrant = {
  id: "quantcomm",
  name: "Quantcomm Flood Research",
  provider: "Quantcomm",
  icon: "",
  color: "#1D4ED8",
  kind: "x402",
  category: "data",
  summary: "",
  baseUrl: "http://localhost:4380/quantcomm",
  pricing: "$0.05 per flood check · $0.10 per analyst view",
  maxPrice: "0.10",
  permissions: ["Pay up to $0.10 per request", "Read Quantcomm's flood and bank research"],
  source: "directory",
} as ServiceGrant;

const approval = (over: Partial<Approval> = {}): Approval =>
  ({
    id: "apr_1",
    kind: "service",
    agentId: "agt_2",
    agentName: "shopper",
    amount: "0.10",
    description: "Connect Quantcomm Flood Research",
    counterparty: { address: "0x0", name: "Quantcomm Flood Research" },
    service: grant,
    status: "pending",
    createdAt: "2026-10-18T13:57:31Z",
    ...over,
  }) as Approval;

describe("shortAgo", () => {
  const now = Date.parse("2026-10-18T14:00:00Z");
  it("is short, like Linear", () => {
    expect(shortAgo("2026-10-18T13:59:58Z", now)).toBe("just now");
    expect(shortAgo("2026-10-18T13:59:48Z", now)).toBe("12s ago");
    expect(shortAgo("2026-10-18T13:57:00Z", now)).toBe("3m ago");
    expect(shortAgo("2026-10-18T09:00:00Z", now)).toBe("5h ago");
    expect(shortAgo("2026-10-17T09:00:00Z", now)).toBe("yesterday");
    expect(shortAgo("2026-10-15T09:00:00Z", now)).toBe("3d ago");
    expect(shortAgo("nope", now)).toBe("");
  });
});

describe("activityLine", () => {
  it("names the agent once, the object once, and leaves the amount out", () => {
    const l = activityLine({ type: "payment.settled", agentName: "researcher", receipt: receipt(), message: "researcher paid $0.05 to Quantcomm Flood Research." });
    expect(l).toMatchObject({ actor: "researcher", verb: "paid", object: "Quantcomm Flood Research", tail: "" });
    expect(lineText(l)).toBe("researcher paid Quantcomm Flood Research");
  });

  it("asks carry a Pending mark only while they wait", () => {
    const e = { type: "service.requested" as const, agentName: "shopper", approval: approval(), message: "" };
    expect(activityLine(e, { pending: true })).toMatchObject({ verb: "asked to connect", object: "Quantcomm Flood Research", status: { text: "Pending", tone: "warn" } });
    expect(activityLine(e).status).toBeUndefined();
  });

  it("top-ups and earnings read as the agent's", () => {
    expect(lineText(activityLine({ type: "topup", agentName: "shopper", receipt: receipt({ kind: "topup", description: "Starting balance", bank: { status: "posted", account: "••0015" } }) }, { checkingLast4: "7688" }))).toBe(
      "shopper was funded from Capital One Checking ••7688",
    );
    expect(lineText(activityLine({ type: "topup", agentName: "shopper", receipt: receipt({ kind: "topup", description: "Top-up" }) }))).toBe("shopper got a top-up");
    expect(lineText(activityLine({ type: "earning.received", agentName: "worker-3", receipt: receipt({ kind: "earn", description: "Bounty: API reliability check" }) }))).toBe(
      "worker-3 earned a bounty for API reliability check",
    );
  });

  it("blocks are a mark plus a short reason, never a red sentence", () => {
    const hard = activityLine({ type: "payment.blocked", agentName: "naive-worker", receipt: receipt({ status: "blocked", counterparty: { address: "0x0000000000000000000000000000000000000002" }, description: "" }) });
    expect(hard).toMatchObject({ verb: "tried to send money to", object: "an unknown address", tail: " · agent frozen", status: { text: "Blocked", tone: "danger" } });
    const transfer = activityLine({ type: "payment.blocked", agentName: "naive-worker", receipt: receipt({ kind: "transfer", status: "blocked", counterparty: { address: "0x0000000000000000000000000000000000000002" }, description: "Transfer" }) });
    expect(lineText(transfer)).toBe("naive-worker tried to send money to an unknown address · agent frozen");
    const soft = activityLine({ type: "payment.blocked", agentName: "shopper", reason: "service_not_connected", data: { service: grant } });
    expect(soft).toMatchObject({ object: "Quantcomm Flood Research", tail: " · not connected", status: { tone: "neutral" } });
  });

  it("decisions and connections", () => {
    expect(lineText(activityLine({ type: "service.connected", agentName: "researcher", data: { service: grant } }))).toBe("researcher can now use Quantcomm Flood Research");
    expect(lineText(activityLine({ type: "approval.approved", agentName: "shopper", approval: approval({ status: "approved", decidedBy: "telegram" }) }))).toBe(
      "shopper was approved to connect Quantcomm Flood Research on Telegram",
    );
    expect(lineText(activityLine({ type: "approval.denied", agentName: "shopper", reason: "expired", approval: approval({ status: "expired" }) }))).toBe(
      "shopper asked to connect Quantcomm Flood Research · expired",
    );
  });

  it("falls back to the wallet's message for types it doesn't know", () => {
    expect(activityLine({ type: "bank.posted" as never, message: "Posted." })).toEqual({ verb: "Posted." });
  });
});

describe("receiptLine", () => {
  it("adds the description only when it says more than the payee", () => {
    expect(lineText(receiptLine(receipt({ description: "Pizza order", counterparty: { address: "0x0000000000000000000000000000000000000003", name: "Acme Pizza" } })))).toBe("researcher paid Acme Pizza · Pizza order");
  });
  it("same words as the feed, status as a mark", () => {
    expect(lineText(receiptLine(receipt()))).toBe("researcher paid Quantcomm Flood Research");
    expect(receiptLine(receipt({ status: "blocked" })).status).toEqual({ text: "Blocked", tone: "danger" });
    expect(receiptLine(receipt({ status: "pending_approval" })).status?.text).toBe("Pending");
  });
});

describe("approval card copy", () => {
  it("one title with the key fact", () => {
    expect(approvalTitle(approval())).toBe("Connect Quantcomm Flood Research?");
    expect(approvalTitle(approval({ kind: "payment", service: undefined, amount: "18.50", counterparty: { address: "0x0", name: "Acme Pizza" } }))).toBe("Pay $18.50 to Acme Pizza?");
    expect(approvalTitle(approval({ service: { ...grant, name: "Juniper Goods", id: "shopify-juniper", source: "agent", shopify: { handle: "juniper", domain: "juniper.myshopify.com" } } as ServiceGrant }))).toBe(
      "Connect Juniper Goods?",
    );
  });

  it("the cap once, permissions without it", () => {
    expect(capMeta("0.10")).toBe("up to $0.10 per request");
    expect(capMeta("150", "order")).toBe("up to $150.00 per order");
    expect(capUnit("$18.50 per order")).toBe("order");
    expect(capUnit("$0.15 per quote")).toBe("quote");
    expect(capUnit(grant.pricing)).toBe("request");
    expect(capUnit("Store prices", true)).toBe("order");
    expect(capMeta("0.00")).toBe("free");
    expect(permissionsLine(grant.permissions)).toBe("Read Quantcomm's flood and bank research");
    expect(permissionsLine(["Pay Acme Weather up to $0.05 per request", "Look up weather", "Read headlines"])).toBe("Look up weather · Read headlines");
    expect(permissionsLine(undefined)).toBe("");
  });

  it("pricing only when it adds to the cap", () => {
    expect(pricingBeyondCap(grant)).toBe("$0.05 per flood check · $0.10 per analyst view");
    expect(pricingBeyondCap({ pricing: "$0.05 per request", maxPrice: "0.05" })).toBe("");
    expect(pricingBeyondCap({ pricing: "Free", maxPrice: "0.00" })).toBe("");
  });
});

describe("amount cells", () => {
  it("signs like a statement", () => {
    expect(eventAmount({ type: "payment.settled", receipt: receipt() })).toEqual({ text: "−$0.05", tone: "out" });
    expect(eventAmount({ type: "topup", receipt: receipt({ kind: "topup", amount: "20.00" }) })).toEqual({ text: "+$20.00", tone: "in" });
    expect(eventAmount({ type: "payment.blocked", receipt: receipt({ amount: "20" }) })).toEqual({ text: "$20.00", tone: "void" });
    expect(eventAmount({ type: "payment.needs_approval", approval: approval({ amount: "18.5" }) })).toEqual({ text: "$18.50", tone: "pending" });
    expect(eventAmount({ type: "approval.approved", approval: approval() })).toBeNull();
    expect(eventAmount({ type: "service.connected" })).toBeNull();
  });
  it("receipts by status", () => {
    expect(receiptAmount(receipt({ status: "denied" })).tone).toBe("void");
    expect(receiptAmount(receipt({ kind: "earn", amount: "0.5" }))).toEqual({ text: "+$0.50", tone: "in" });
  });
});
