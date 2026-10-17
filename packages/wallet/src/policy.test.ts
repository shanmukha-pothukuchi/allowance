import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, toBaseUnits } from "@allowance/shared";
import type { Address, Policy } from "@allowance/shared";
import { evaluate, isAllowlisted } from "./policy.js";

const TO = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const MERCHANT = "http://localhost:4021";

const policy: Policy = { ...DEFAULT_POLICY, maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "1.00" };
const req = (dollars: string, extra: Partial<{ to: Address; origin: string }> = {}) => ({
  amountBaseUnits: toBaseUnits(dollars),
  to: extra.to ?? TO,
  origin: extra.origin,
});

describe("evaluate", () => {
  it("allows a small payment", () => {
    expect(evaluate(policy, 0n, req("0.05"))).toEqual({ outcome: "allow" });
  });

  it("needs approval strictly above the threshold, not at it", () => {
    expect(evaluate(policy, 0n, req("1.00"))).toEqual({ outcome: "allow" });
    expect(evaluate(policy, 0n, req("1.000001"))).toEqual({ outcome: "needs_approval", reason: "over_approval_threshold" });
    expect(evaluate(policy, 0n, req("4.50"))).toMatchObject({ outcome: "needs_approval" });
  });

  it("threshold 0 means everything needs approval (except free)", () => {
    const p = { ...policy, approvalThreshold: "0" };
    expect(evaluate(p, 0n, req("0.01"))).toMatchObject({ outcome: "needs_approval" });
    expect(evaluate(p, 0n, req("0"))).toEqual({ outcome: "allow" });
  });

  it("blocks when frozen, before anything else", () => {
    const d = evaluate({ ...policy, frozen: true }, 0n, req("0.01"));
    expect(d).toMatchObject({ outcome: "block", reason: "frozen" });
    expect((d as { message: string }).message).toContain("$0.01");
  });

  it("blocks over maxPerTx with a dollar message", () => {
    const d = evaluate(policy, 0n, req("5.01"));
    expect(d).toMatchObject({ outcome: "block", reason: "max_per_tx" });
    expect((d as { message: string }).message).toMatch(/^Blocked: tried to send \$5\.01.*\$5\.00/);
    expect(evaluate(policy, 0n, req("5.00"))).toMatchObject({ outcome: "needs_approval" });
  });

  it("blocks when the daily cap would be passed, allows exactly reaching it", () => {
    expect(evaluate(policy, toBaseUnits("24.00"), req("1.00"))).toEqual({ outcome: "allow" });
    const d = evaluate(policy, toBaseUnits("24.00"), req("1.01"));
    expect(d).toMatchObject({ outcome: "block", reason: "daily_cap" });
    expect((d as { message: string }).message).toContain("$25.00");
    expect((d as { message: string }).message).toContain("$24.00");
  });

  it("checks max_per_tx before daily_cap", () => {
    expect(evaluate(policy, toBaseUnits("25.00"), req("6.00"))).toMatchObject({ reason: "max_per_tx" });
  });

  describe("allowlist", () => {
    it("null allowlist: anything goes", () => {
      expect(evaluate({ ...policy, allowlist: null }, 0n, req("0.10", { to: OTHER }))).toEqual({ outcome: "allow" });
    });

    it("empty allowlist: nothing is allowed", () => {
      const p = { ...policy, allowlist: { addresses: [], origins: [] } };
      const d = evaluate(p, 0n, req("4.50", { to: OTHER }));
      expect(d).toMatchObject({ outcome: "block", reason: "not_allowlisted" });
      expect((d as { message: string }).message).toBe("Blocked: tried to send $4.50 to an unknown address.");
    });

    it("address match (case-insensitive)", () => {
      const p = { ...policy, allowlist: { addresses: [TO.toUpperCase().replace("0X", "0x") as Address], origins: [] } };
      expect(evaluate(p, 0n, req("0.10", { to: TO }))).toEqual({ outcome: "allow" });
      expect(evaluate(p, 0n, req("0.10", { to: OTHER }))).toMatchObject({ reason: "not_allowlisted" });
    });

    it("origin match for x402 payments, with a site message", () => {
      const p = { ...policy, allowlist: { addresses: [], origins: [MERCHANT] } };
      expect(evaluate(p, 0n, req("0.10", { to: OTHER, origin: MERCHANT }))).toEqual({ outcome: "allow" });
      expect(evaluate(p, 0n, req("0.10", { to: OTHER, origin: "http://localhost:4021/" }))).toEqual({ outcome: "allow" });
      const d = evaluate(p, 0n, req("0.10", { to: OTHER, origin: "http://evil.example" }));
      expect(d).toMatchObject({ reason: "not_allowlisted" });
      expect((d as { message: string }).message).toContain("unknown site");
    });

    it("direct transfers have no origin, so origins never match them", () => {
      const p = { ...policy, allowlist: { addresses: [], origins: [MERCHANT] } };
      expect(evaluate(p, 0n, req("0.10", { to: OTHER }))).toMatchObject({ reason: "not_allowlisted" });
    });

    it("allowlist is checked before approval threshold", () => {
      const p = { ...policy, allowlist: { addresses: [], origins: [] } };
      expect(evaluate(p, 0n, req("4.50"))).toMatchObject({ outcome: "block", reason: "not_allowlisted" });
    });

    it("isAllowlisted helper", () => {
      expect(isAllowlisted({ addresses: [TO], origins: [] }, { to: TO })).toBe(true);
      expect(isAllowlisted({ addresses: [], origins: [MERCHANT] }, { to: TO })).toBe(false);
      expect(isAllowlisted({ addresses: [], origins: [MERCHANT] }, { to: TO, origin: MERCHANT })).toBe(true);
    });
  });

  it("never mutates the policy", () => {
    const p = { ...policy, allowlist: { addresses: [TO], origins: [] } };
    const snapshot = JSON.stringify(p);
    evaluate(p, 0n, req("100"));
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
