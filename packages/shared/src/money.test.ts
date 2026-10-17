import { describe, it, expect } from "vitest";
import { toBaseUnits, toDollars, formatUsd } from "./money.js";
import { localDayKey, hashToken, newAgentToken } from "./ids.js";
import { redact } from "./redact.js";

describe("money", () => {
  it("round-trips dollars and base units", () => {
    expect(toBaseUnits("18.50")).toBe(18_500_000n);
    expect(toBaseUnits("$0.05")).toBe(50_000n);
    expect(toBaseUnits(1)).toBe(1_000_000n);
    expect(toBaseUnits("0.000001")).toBe(1n);
    expect(toDollars(18_500_000n)).toBe("18.50");
    expect(toDollars("50000")).toBe("0.05");
    expect(toDollars(1n)).toBe("0.000001");
    expect(formatUsd(1_234_560_000n)).toBe("$1234.56");
    expect(formatUsd(-50_000n)).toBe("-$0.05");
  });
  it("rejects garbage", () => {
    expect(() => toBaseUnits("abc")).toThrow();
    expect(() => toBaseUnits("1.1234567")).toThrow();
    expect(() => toBaseUnits("")).toThrow();
  });
});

describe("ids", () => {
  it("tokens hash deterministically and look right", () => {
    const t = newAgentToken();
    expect(t).toMatch(/^aw_[0-9a-f]{48}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(hashToken(newAgentToken()));
  });
  it("day key is local", () => {
    expect(localDayKey(new Date(2026, 9, 17, 23, 59))).toBe("2026-10-17");
  });
});

describe("redact", () => {
  it("strips private keys by field name", () => {
    const out = redact({ a: { privateKey: "0xabc", address: "0x1" }, list: [{ secret: "s" }] });
    expect(out).toEqual({ a: { privateKey: "[redacted]", address: "0x1" }, list: [{ secret: "[redacted]" }] });
  });
});
