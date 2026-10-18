import { describe, expect, it } from "vitest";
import {
  addStoreBody,
  capLabel,
  catalogLine,
  checkCap,
  checkStoreLink,
  DEFAULT_CAP,
  existingStore,
  isShopify,
  modeExplain,
  modeLabel,
  prettyHandle,
  serviceIdFor,
  SHOPIFY_GREEN,
  shopifyRefOf,
  storeErrorMessage,
  unwrapAdded,
  unwrapStore,
} from "./shopify";

describe("which services are Shopify stores", () => {
  it("knows a store by its `shopify` field or its shopify-<handle> id", () => {
    expect(isShopify({ id: "x", shopify: { handle: "x", domain: "x.myshopify.com", mode: "handoff" } })).toBe(true);
    expect(isShopify({ id: "shopify-crypto-app-test" })).toBe(true);
    expect(isShopify({ id: "acme-pizza" })).toBe(false);
    expect(isShopify(undefined)).toBe(false);
    expect(serviceIdFor("crypto-app-test")).toBe("shopify-crypto-app-test");
    expect(SHOPIFY_GREEN).toBe("#95BF47");
  });

  it("reads handle, domain and mode, deriving what is missing", () => {
    const full = { id: "shopify-a", shopify: { handle: "a", domain: "a.example.com", mode: "agent_checkout" as const } };
    expect(shopifyRefOf(full)).toEqual({ handle: "a", domain: "a.example.com", mode: "agent_checkout" });
    expect(shopifyRefOf({ id: "shopify-juniper-goods", pricing: "Browse only · you pay at Shopify checkout" })).toEqual({ handle: "juniper-goods", domain: "juniper-goods.myshopify.com", mode: "handoff" });
    expect(shopifyRefOf({ id: "shopify-x", pricing: "Varies by item · up to $100.00 per order" })?.mode).toBe("agent_checkout");
    expect(shopifyRefOf({ id: "shopify-x", maxPrice: "0.00", pricing: "" })?.mode).toBe("handoff");
    expect(shopifyRefOf({ id: "acme-pizza" })).toBeUndefined();
  });
});

describe("owner words", () => {
  it("labels and explains the two modes the same way as the chat", () => {
    expect(modeLabel("agent_checkout")).toBe("Agent checkout");
    expect(modeLabel("handoff")).toBe("Browse only");
    expect(modeExplain("agent_checkout", "100")).toBe("Your agent pays in USDC, up to $100.00 per order, and a real order lands in your Shopify admin.");
    expect(modeExplain("agent_checkout")).toBe("Your agent pays in USDC, and a real order lands in your Shopify admin.");
    expect(modeExplain("handoff", "100")).toBe("Your agent browses and builds a cart. You finish paying at Shopify's checkout.");
    expect(capLabel("agent_checkout", "250")).toBe("Up to $250.00 per order");
    expect(capLabel("handoff", "100")).toBe("No agent payments");
  });

  it("names and sizes a store", () => {
    expect(prettyHandle("juniper-goods")).toBe("Juniper Goods");
    expect(catalogLine({ productCount: 14, currency: "USD" })).toBe("14 products · USD");
    expect(catalogLine({ productCount: 1, currency: "USD" })).toBe("1 product · USD");
    expect(catalogLine({ currency: "USD" })).toBe("USD");
  });

  it("turns preview and add errors into sentences", () => {
    expect(storeErrorMessage({ status: 400, code: "invalid_store_url", message: "bad" })).toMatch(/doesn't look like a store link/);
    expect(storeErrorMessage({ status: 404, code: "store_not_found" })).toMatch(/No Shopify store answers/);
    expect(storeErrorMessage({ status: 422, code: "store_unsupported", message: "This store sells in EUR." })).toBe("This store sells in EUR.");
    expect(storeErrorMessage({ status: 422, code: "store_unsupported", message: "" })).toBe("Agents can't shop at this store.");
    expect(storeErrorMessage({ status: 409, code: "service_exists", message: "x" })).toBe("This store is already in your services.");
    expect(storeErrorMessage({ status: 503, code: "bridge_unreachable" })).toMatch(/bridge isn't answering/);
    expect(storeErrorMessage({ message: "Failed to fetch" })).toBe("Failed to fetch");
  });
});

describe("the store link", () => {
  it("is idle when empty and sends the origin for anything that looks like a host", () => {
    expect(checkStoreLink("   ")).toEqual({ state: "idle" });
    expect(checkStoreLink("crypto-app-test.myshopify.com")).toEqual({ state: "ok", url: "https://crypto-app-test.myshopify.com", key: "crypto-app-test.myshopify.com", host: "crypto-app-test.myshopify.com", handle: "crypto-app-test" });
    expect(checkStoreLink(" https://Crypto-App-Test.myshopify.com/products/hoodie?x=1 ")).toMatchObject({ state: "ok", url: "https://crypto-app-test.myshopify.com", handle: "crypto-app-test" });
    expect(checkStoreLink("shop.example.com")).toEqual({ state: "ok", url: "https://shop.example.com", key: "shop.example.com", host: "shop.example.com" });
    expect(checkStoreLink("http://www.junipergoods.com/")).toMatchObject({ state: "ok", url: "https://www.junipergoods.com" });
  });

  it("catches obvious typos without a round trip", () => {
    for (const bad of ["not a url", "hello", "crypto-app-test", "ftp://x.myshopify.com", "x..com", "-x.myshopify.com", "x.c0m", "myshopify.com", "admin.shopify.com"]) {
      expect(checkStoreLink(bad).state, bad).toBe("bad");
    }
    const r = checkStoreLink("not a url");
    expect(r.state === "bad" && r.message).toMatch(/crypto-app-test\.myshopify\.com/);
  });

  it("finds a store that is already in the directory by id, handle or domain", () => {
    const dir = [
      { id: "acme-pizza" },
      { id: "shopify-crypto-app-test", shopify: { handle: "crypto-app-test", domain: "crypto-app-test.myshopify.com", mode: "agent_checkout" as const } },
    ];
    expect(existingStore(dir, { handle: "crypto-app-test", domain: "crypto-app-test.myshopify.com" })?.id).toBe("shopify-crypto-app-test");
    expect(existingStore(dir, { handle: "other", domain: "crypto-app-test.myshopify.com" })?.id).toBe("shopify-crypto-app-test");
    expect(existingStore(dir, { handle: "juniper-goods", domain: "juniper-goods.myshopify.com" })).toBeUndefined();
  });
});

describe("cap and request body", () => {
  it("accepts $0.01 to $1,000 per order, $100 by default", () => {
    expect(DEFAULT_CAP).toBe("100.00");
    expect(checkCap("250")).toMatchObject({ ok: true, amount: "250.00" });
    expect(checkCap("$1,000")).toMatchObject({ ok: true, amount: "1000.00" });
    expect(checkCap("1000.01")).toEqual({ ok: false, message: "At most $1,000.00 per order." });
    expect(checkCap("0")).toMatchObject({ ok: false });
    expect(checkCap("")).toMatchObject({ ok: false, empty: true });
  });

  it("sends the cap only for agent checkout and connectTo only when someone is picked", () => {
    expect(addStoreBody({ url: "https://a.myshopify.com", mode: "agent_checkout", cap: "250.00", connectTo: ["agt_1", "agt_1", "agt_2"] })).toEqual({
      url: "https://a.myshopify.com",
      maxPrice: "250.00",
      connectTo: ["agt_1", "agt_2"],
    });
    expect(addStoreBody({ url: "https://b.myshopify.com", mode: "handoff", cap: "250.00", connectTo: [] })).toEqual({ url: "https://b.myshopify.com" });
  });

  it("accepts either response shape from the wallet", () => {
    const store = { handle: "a", domain: "a.myshopify.com", mode: "handoff" as const, name: "A", currency: "USD" };
    expect(unwrapStore(store)).toEqual(store);
    expect(unwrapStore({ store })).toEqual(store);
    const service = { id: "shopify-a", name: "A" };
    expect(unwrapAdded({ service, agents: [] })).toEqual({ service, agents: [] });
    expect(unwrapAdded(service)).toEqual({ service });
  });
});
