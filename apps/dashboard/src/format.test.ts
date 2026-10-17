import { describe, expect, it } from "vitest";
import { addDollars, approvalOutcomeLabel, describeEvent, fromCents, isServiceApproval, isSoftBlock, money, pctOf, relativeTime, serviceOfEvent, shortHex, signedMoney, toCents } from "./format";
import type { Receipt } from "./types";

describe("money", () => {
  it("formats dollar strings with two decimals", () => {
    expect(money("18.5")).toBe("$18.50");
    expect(money("0.05")).toBe("$0.05");
    expect(money("20")).toBe("$20.00");
    expect(money("1234.5")).toBe("$1,234.50");
    expect(money(0)).toBe("$0.00");
  });
  it("handles negatives and garbage", () => {
    expect(money("-4.5")).toBe("-$4.50");
    expect(money(undefined)).toBe("$0.00");
    expect(money("abc")).toBe("$0.00");
  });
  it("signs amounts for feeds", () => {
    expect(signedMoney("0.5", "+")).toBe("+$0.50");
    expect(signedMoney("0.05", "-")).toBe("-$0.05");
  });
  it("round-trips cents exactly", () => {
    expect(toCents("18.50")).toBe(1850);
    expect(toCents("$0.05")).toBe(5);
    expect(fromCents(1850)).toBe("18.50");
    expect(fromCents(5)).toBe("0.05");
    expect(addDollars("0.10", "0.20")).toBe("0.30");
    expect(addDollars("19.99", "0.01")).toBe("20.00");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  it("reads naturally", () => {
    expect(relativeTime("2026-10-17T11:59:58Z", now)).toBe("just now");
    expect(relativeTime("2026-10-17T11:59:48Z", now)).toBe("12 s ago");
    expect(relativeTime("2026-10-17T11:57:00Z", now)).toBe("3 min ago");
    expect(relativeTime("2026-10-17T10:00:00Z", now)).toBe("2 h ago");
    expect(relativeTime("2026-10-16T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-14T10:00:00Z", now)).toBe("3 d ago");
  });
  it("never goes negative", () => {
    expect(relativeTime("2026-10-17T12:00:30Z", now)).toBe("just now");
    expect(relativeTime("garbage", now)).toBe("");
  });
});

describe("misc", () => {
  it("shortens hex", () => {
    expect(shortHex("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortHex("0xabc")).toBe("0xabc");
    expect(shortHex(undefined)).toBe("");
  });
  it("clamps percentages", () => {
    expect(pctOf("2.50", "5.00")).toBe(50);
    expect(pctOf("9", "5")).toBe(100);
    expect(pctOf("1", "0")).toBe(0);
  });
});

describe("describeEvent", () => {
  const receipt: Receipt = {
    id: "rcp_1",
    kind: "spend",
    status: "signed",
    agentId: "agt_1",
    agentName: "researcher",
    description: "Acme Weather",
    amount: "0.05",
    amountBaseUnits: "50000",
    counterparty: { address: "0x9A3c0F1b7D2e4C5a6B7C8d9E0F1a2B3c4D5E6F70", origin: "http://localhost:4021", name: "Acme Weather" },
    network: "eip155:84532",
    createdAt: "2026-10-17T12:00:00Z",
  };
  it("prefers the server message", () => {
    expect(describeEvent({ type: "payment.settled", message: "Paid $0.05 to Acme Weather.", receipt })).toBe("Paid $0.05 to Acme Weather.");
  });
  it("builds friendly sentences when message is missing", () => {
    expect(describeEvent({ type: "payment.settled", message: "", receipt })).toBe("Paid $0.05 to Acme Weather.");
    expect(describeEvent({ type: "earning.received", message: "", agentName: "worker-1", receipt: { ...receipt, kind: "earn", amount: "0.50", description: "Bounty: API reliability check" } })).toBe(
      "Earned $0.50 for Bounty: API reliability check.",
    );
    expect(
      describeEvent({
        type: "payment.blocked",
        message: "",
        agentName: "naive-worker",
        reason: "not_allowlisted",
        receipt: { ...receipt, kind: "transfer", amount: "4.50", description: "", counterparty: { address: "0x000000000000000000000000000000000000dEaD" } },
      }),
    ).toBe("Blocked: naive-worker tried to send $4.50 to an unknown address. Agent frozen.");
    expect(describeEvent({ type: "agent.unfrozen", message: "", agentName: "shopper" })).toBe("Shopper is unfrozen.");
  });
});

describe("services: sentences and labels", () => {
  const grant = { id: "acme-pizza", name: "Acme Pizza", provider: "Acme Corp", icon: "🍕", color: "#F08A24", kind: "x402" as const, summary: "", baseUrl: "http://localhost:4021/pizza", pricing: "$18.50 per order", maxPrice: "18.50", permissions: [], source: "directory" as const };
  const approval = {
    id: "apr_s",
    kind: "service" as const,
    agentId: "agt_b",
    agentName: "shopper",
    paymentId: "",
    amount: "18.50",
    description: "Connect Acme Pizza",
    counterparty: { address: "0x2222222222222222222222222222222222222222" as const, name: "Acme Pizza" },
    service: grant,
    status: "pending" as const,
    createdAt: "2026-10-17T12:00:00Z",
  };
  it("prefers the server's service messages", () => {
    expect(describeEvent({ type: "service.requested", message: "shopper wants to connect Acme Pizza.", approval })).toBe("shopper wants to connect Acme Pizza.");
  });
  it("builds request / connect / disconnect sentences (§13.2 wording)", () => {
    expect(describeEvent({ type: "service.requested", message: "", agentName: "shopper", approval })).toBe("shopper wants to connect Acme Pizza (up to $18.50 per payment).");
    expect(describeEvent({ type: "service.requested", message: "", agentName: "worker-1", approval: { ...approval, service: { ...grant, name: "Acme Bounties", maxPrice: "0.00" } } })).toBe("worker-1 wants to connect Acme Bounties (free).");
    expect(describeEvent({ type: "service.requested", message: "", agentName: "researcher", approval: { ...approval, service: { ...grant, name: "HN Digest", maxPrice: "0.25", source: "agent" } } })).toBe(
      "researcher wants to connect HN Digest, a service it proposed (up to $0.25 per payment).",
    );
    expect(describeEvent({ type: "service.connected", message: "", agentName: "shopper", data: { service: grant, connectedBy: "approval" } })).toBe("Acme Pizza connected to shopper.");
    expect(describeEvent({ type: "service.disconnected", message: "", agentName: "shopper", data: { serviceId: "acme-pizza", serviceName: "Acme Pizza" } })).toBe("Acme Pizza disconnected from shopper.");
  });
  it("never words a service decision as a payment", () => {
    expect(describeEvent({ type: "approval.approved", message: "", agentName: "shopper", approval: { ...approval, status: "approved" } })).toBe("Approved connecting Acme Pizza to shopper.");
    expect(describeEvent({ type: "approval.denied", message: "", agentName: "shopper", approval: { ...approval, status: "denied" } })).toBe("Denied connecting Acme Pizza to shopper.");
    expect(describeEvent({ type: "approval.denied", message: "", agentName: "shopper", reason: "expired", approval: { ...approval, status: "expired" } })).toBe("Request to connect Acme Pizza to shopper expired.");
    expect(isServiceApproval(approval)).toBe(true);
    expect(isServiceApproval({ kind: undefined, service: undefined })).toBe(false);
    expect(isServiceApproval({ kind: undefined, service: grant })).toBe(true); // older server without kind
    expect(serviceOfEvent({ approval })?.name).toBe("Acme Pizza");
    expect(serviceOfEvent({ data: { serviceId: "x" } })?.id).toBe("x");
  });
  it("tells soft blocks (no freeze) from freezing ones", () => {
    const blocked = (reason: string, data?: Record<string, unknown>) => ({ type: "payment.blocked" as const, reason, data });
    expect(isSoftBlock(blocked("service_not_connected"))).toBe(true);
    expect(isSoftBlock(blocked("service_cap"))).toBe(true);
    expect(isSoftBlock(blocked("insufficient_balance"))).toBe(true);
    expect(isSoftBlock(blocked("not_allowlisted"))).toBe(false);
    expect(isSoftBlock(blocked("not_allowlisted", { willFreeze: false }))).toBe(true);
    expect(describeEvent({ type: "payment.blocked", message: "", agentName: "shopper", reason: "service_not_connected", data: { service: grant } })).toBe(
      "Acme Pizza is not connected for shopper. It can ask you to connect it.",
    );
  });
  it("describes a decided approval for the card", () => {
    expect(approvalOutcomeLabel({ status: "approved", decidedBy: "telegram" })).toBe("Approved on Telegram");
    expect(approvalOutcomeLabel({ status: "denied", decidedBy: "dashboard" })).toBe("Denied by you");
    expect(approvalOutcomeLabel({ status: "expired" })).toMatch(/^Expired/);
  });
});
