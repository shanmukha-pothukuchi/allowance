import { describe, expect, it } from "vitest";
import { addDollars, describeEvent, fromCents, money, pctOf, relativeTime, shortHex, signedMoney, toCents } from "./format";
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
