import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, toBaseUnits } from "@allowance/shared";
import type { Address, Policy } from "@allowance/shared";
import { allowlistMatch, evaluate, findService, isAllowlisted, urlMatchesBase } from "./policy.js";
import type { ServiceRef } from "./policy.js";

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

  describe("connected services", () => {
    const closed = { ...policy, maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: { addresses: [] as Address[], origins: [] as string[] } };
    const pizza: ServiceRef = { id: "acme-pizza", name: "Acme Pizza", kind: "x402", baseUrl: `${MERCHANT}/pizza`, maxPrice: "18.50" };
    const weather: ServiceRef = { id: "acme-weather", name: "Acme Weather", kind: "x402", baseUrl: `${MERCHANT}/api/weather`, maxPrice: "0.05" };
    const bounties: ServiceRef = { id: "acme-bounties", name: "Acme Bounties", kind: "agent-work", baseUrl: MERCHANT, maxPrice: "0.00" };
    const directory: ServiceRef[] = [pizza, weather, bounties];
    const pay = (dollars: string, url: string) => ({ amountBaseUnits: toBaseUnits(dollars), to: OTHER, origin: new URL(url).origin, url });

    it("allows a URL under a connected x402 service", () => {
      expect(evaluate(closed, 0n, pay("0.05", `${MERCHANT}/api/weather?city=Paris`), { services: [weather] })).toEqual({ outcome: "allow" });
      expect(allowlistMatch(closed.allowlist, pay("0.05", `${MERCHANT}/api/weather`), [weather])).toEqual({ via: "service", service: weather });
    });

    it("still applies the approval threshold to service payments", () => {
      expect(evaluate(closed, 0n, pay("18.50", `${MERCHANT}/pizza/order`), { services: [pizza] })).toEqual({ outcome: "needs_approval", reason: "over_approval_threshold" });
    });

    it("blocks over the service's maxPrice with service_cap", () => {
      const p = { ...closed, maxPerTx: "50.00", dailyCap: "100.00" };
      const d = evaluate(p, 0n, pay("18.51", `${MERCHANT}/pizza/order`), { services: [pizza] });
      expect(d).toMatchObject({ outcome: "block", reason: "service_cap" });
      expect((d as { message: string }).message).toBe("Blocked: tried to send $18.51 to Acme Pizza, over its $18.50 per-payment cap.");
      // A free service caps at zero; a malformed cap never fails open.
      const free = { ...weather, maxPrice: "0.00" };
      expect(evaluate(p, 0n, pay("0.01", `${MERCHANT}/api/weather`), { services: [free] })).toMatchObject({ reason: "service_cap" });
      expect(evaluate(p, 0n, pay("0.01", `${MERCHANT}/api/weather`), { services: [{ ...weather, maxPrice: "lots" }] })).toMatchObject({ reason: "service_cap" });
    });

    it("hard caps come before the service check", () => {
      expect(evaluate({ ...closed, maxPerTx: "1.00" }, 0n, pay("18.50", `${MERCHANT}/pizza/order`), { services: [pizza] })).toMatchObject({ reason: "max_per_tx" });
      expect(evaluate(closed, toBaseUnits("40.00"), pay("18.50", `${MERCHANT}/pizza/order`), { services: [pizza] })).toMatchObject({ reason: "daily_cap" });
      expect(evaluate({ ...closed, frozen: true }, 0n, pay("0.05", `${MERCHANT}/api/weather`), { services: [weather] })).toMatchObject({ reason: "frozen" });
    });

    it("a known but unconnected directory service is service_not_connected, with the agent's name", () => {
      const d = evaluate(closed, 0n, pay("18.50", `${MERCHANT}/pizza/order`), { services: [weather], directory, agentName: "shopper" });
      expect(d).toEqual({ outcome: "block", reason: "service_not_connected", message: "Acme Pizza is not connected for shopper. Ask the owner with request_service." });
    });

    it("without the directory (unreachable) the same payment is plain not_allowlisted", () => {
      expect(evaluate(closed, 0n, pay("18.50", `${MERCHANT}/pizza/order`), { services: [] })).toMatchObject({ reason: "not_allowlisted" });
    });

    it("an unknown URL or a direct transfer stays not_allowlisted even with the directory", () => {
      expect(evaluate(closed, 0n, pay("1.00", "http://evil.example/pizza/order"), { directory })).toMatchObject({ reason: "not_allowlisted" });
      // acme-bounties covers the whole merchant origin but is agent-work: it never names a payment.
      expect(evaluate(closed, 0n, pay("1.00", `${MERCHANT}/admin`), { directory })).toMatchObject({ reason: "not_allowlisted" });
      expect(evaluate(closed, 0n, req("1.00", { to: OTHER }), { directory, services: [pizza] })).toMatchObject({ reason: "not_allowlisted" });
    });

    it("agent-work services never allowlist payments", () => {
      expect(evaluate(closed, 0n, pay("0.10", `${MERCHANT}/api/news`), { services: [bounties] })).toMatchObject({ reason: "not_allowlisted" });
    });

    it("address and origin rules win over services (no service cap)", () => {
      const p = { ...closed, maxPerTx: "50.00", dailyCap: "100.00", allowlist: { addresses: [], origins: [MERCHANT] } };
      expect(evaluate(p, 0n, pay("30.00", `${MERCHANT}/pizza/order`), { services: [pizza] })).toMatchObject({ outcome: "needs_approval" });
      expect(allowlistMatch(p.allowlist, pay("1.00", `${MERCHANT}/pizza/order`), [pizza])).toEqual({ via: "origin" });
      expect(allowlistMatch({ addresses: [OTHER], origins: [] }, pay("1.00", `${MERCHANT}/pizza/order`), [pizza])).toEqual({ via: "address" });
    });

    it("null allowlist ignores services entirely", () => {
      expect(evaluate({ ...closed, allowlist: null }, 0n, pay("19.00", `${MERCHANT}/pizza/order`), { services: [pizza], directory })).toMatchObject({ outcome: "needs_approval" });
    });

    it("picks the most specific matching service", () => {
      const api: ServiceRef = { id: "custom-api", name: "All APIs", kind: "x402", baseUrl: `${MERCHANT}/api`, maxPrice: "1.00" };
      expect(findService(`${MERCHANT}/api/weather?city=Oslo`, [api, weather])?.id).toBe("acme-weather");
      expect(findService(`${MERCHANT}/api/news`, [api, weather])?.id).toBe("custom-api");
      expect(isAllowlisted(closed.allowlist, pay("0.05", `${MERCHANT}/api/weather`), [api])).toBe(true);
    });
  });

  describe("urlMatchesBase (path-boundary prefix)", () => {
    const base = "http://x/pizza";
    it.each([
      ["http://x/pizza", true],
      ["http://x/pizza/", true],
      ["http://x/pizza/order", true],
      ["http://x/pizza?size=large", true],
      ["http://x/pizza#top", true],
      ["HTTP://X/pizza/order", true],
      ["http://x:80/pizza/order", true],
      ["http://x/api/../pizza/order", true],
      ["http://x/pizzas", false],
      ["http://x/pizza-party", false],
      ["http://x/pizz", false],
      ["http://x/", false],
      ["http://x/PIZZA/order", false],
      ["http://x/pizza/../admin", false],
      ["http://x/pizza%2F..%2Fadmin", false],
      ["https://x/pizza/order", false],
      ["http://x:8080/pizza/order", false],
      ["http://y/pizza/order", false],
      ["http://x.evil.com/pizza", false],
      ["http://x@evil.com/pizza", false],
      ["http://user:pw@x/pizza", false],
      ["not a url", false],
      ["ftp://x/pizza", false],
    ])("%s → %s", (url, expected) => {
      expect(urlMatchesBase(url, base)).toBe(expected);
    });

    it("a trailing slash on the base is the same base; a root base covers the whole origin", () => {
      expect(urlMatchesBase("http://x/pizza/order", "http://x/pizza/")).toBe(true);
      expect(urlMatchesBase("http://x/pizzas", "http://x/pizza/")).toBe(false);
      expect(urlMatchesBase("http://x/anything", "http://x")).toBe(true);
      expect(urlMatchesBase("http://x/anything", "http://x/")).toBe(true);
      expect(urlMatchesBase("http://x/pizza", "garbage")).toBe(false);
    });
  });

  it("never mutates the policy", () => {
    const p = { ...policy, allowlist: { addresses: [TO], origins: [] } };
    const snapshot = JSON.stringify(p);
    evaluate(p, 0n, req("100"));
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
