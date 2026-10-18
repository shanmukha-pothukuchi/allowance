import { describe, expect, it } from "vitest";
import {
  ADMIN_LINK_MESSAGE,
  addStoreBody,
  capLabel,
  catalogLine,
  checkCap,
  checkStoreLink,
  DEFAULT_CAP,
  existingStore,
  HOW_IT_PAYS,
  isShopify,
  prettyHandle,
  pricingWithoutCap,
  sampleImagesOf,
  serviceIdFor,
  SHOPIFY_GREEN,
  shopifyRefOf,
  storefrontHost,
  storefrontOrigin,
  storeErrorMessage,
  unwrapAdded,
  unwrapStore,
} from "./shopify";

const allbirds = { handle: "weareallbirds", domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com", cardCheckout: true };

describe("which services are Shopify stores", () => {
  it("knows a store by its `shopify` field or its shopify-<handle> id", () => {
    expect(isShopify({ id: "x", shopify: allbirds })).toBe(true);
    expect(isShopify({ id: "shopify-weareallbirds" })).toBe(true);
    expect(isShopify({ id: "acme-pizza" })).toBe(false);
    expect(isShopify(undefined)).toBe(false);
    expect(serviceIdFor("weareallbirds")).toBe("shopify-weareallbirds");
    expect(SHOPIFY_GREEN).toBe("#95BF47");
  });

  it("reads handle, domain, storefront and card checkout, deriving what is missing", () => {
    expect(shopifyRefOf({ id: "shopify-weareallbirds", shopify: allbirds })).toEqual(allbirds);
    expect(shopifyRefOf({ id: "shopify-juniper-goods" })).toEqual({ handle: "juniper-goods", domain: "juniper-goods.myshopify.com", storefrontUrl: "https://juniper-goods.myshopify.com", cardCheckout: false });
    // A storefront is only ever a store's own public address: never Shopify's admin.
    expect(shopifyRefOf({ id: "shopify-x", shopify: { handle: "x", domain: "x.myshopify.com", storefrontUrl: "https://admin.shopify.com/store/x" } })?.storefrontUrl).toBe("https://x.myshopify.com");
    expect(shopifyRefOf({ id: "acme-pizza" })).toBeUndefined();
  });

  it("names a store by its storefront's domain", () => {
    expect(storefrontHost(allbirds)).toBe("allbirds.com");
    expect(storefrontHost({ domain: "juniper-goods.myshopify.com", storefrontUrl: "" })).toBe("juniper-goods.myshopify.com");
    expect(storefrontOrigin("https://www.allbirds.com/products/mens-wool-runners?variant=1")).toBe("https://www.allbirds.com");
    expect(storefrontOrigin("javascript:alert(1)")).toBe("");
    expect(storefrontOrigin("https://admin.shopify.com/store/x")).toBe("");
    expect(storefrontOrigin(undefined)).toBe("");
  });
});

describe("owner words", () => {
  it("states the cap and how paying works, without modes", () => {
    expect(capLabel("250")).toBe("Up to $250.00 per order");
    expect(capLabel("0.00")).toBe("No cap set");
    expect(pricingWithoutCap("Store prices · paid with your Allowance card · up to $1,000.00 per order")).toBe("Store prices · paid with your Allowance card");
    expect(pricingWithoutCap("Store prices")).toBe("Store prices");
    expect(pricingWithoutCap(undefined)).toBe("");
    expect(HOW_IT_PAYS).toMatch(/USDC/);
    expect(HOW_IT_PAYS).toMatch(/single-use Allowance Card/);
    expect(HOW_IT_PAYS).toMatch(/simulated/);
  });

  it("names and sizes a store", () => {
    expect(prettyHandle("juniper-goods")).toBe("Juniper Goods");
    expect(catalogLine({ productCount: 248 })).toBe("248 products");
    expect(catalogLine({ productCount: 1 })).toBe("1 product");
    expect(catalogLine({ productCount: 1200 })).toBe("1,200 products");
    expect(catalogLine({})).toBe("");
  });

  it("keeps up to four product pictures: web images and inline images only", () => {
    const svg = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    expect(sampleImagesOf({ sampleImages: ["https://cdn.shopify.com/a.jpg", svg, "javascript:alert(1)", "data:text/html,x", "http://x/b.png", "https://c", "https://d"] })).toEqual([
      "https://cdn.shopify.com/a.jpg",
      svg,
      "http://x/b.png",
      "https://c",
    ]);
    expect(sampleImagesOf({})).toEqual([]);
    expect(sampleImagesOf(undefined)).toEqual([]);
  });

  it("turns preview and add errors into sentences, preferring the backend's own message", () => {
    expect(storeErrorMessage({ status: 400, code: "invalid_store_url", message: "bad" })).toMatch(/doesn't look like a store link/);
    expect(storeErrorMessage({ status: 400, code: "invalid_store_url", message: "That's a store admin link; paste the shop's own address" })).toBe(ADMIN_LINK_MESSAGE);
    expect(storeErrorMessage({ status: 404, code: "store_not_found" })).toMatch(/No Shopify store answers/);
    expect(storeErrorMessage({ status: 422, code: "store_unsupported", message: "This store's catalog is password-protected." })).toBe("This store's catalog is password-protected.");
    expect(storeErrorMessage({ status: 422, code: "store_unsupported", message: "" })).toBe("Agents can't shop at this store.");
    expect(storeErrorMessage({ status: 409, code: "service_exists", message: "x" })).toBe("This store is already in your services.");
    expect(storeErrorMessage({ status: 503, code: "bridge_unreachable" })).toMatch(/bridge isn't answering/);
    expect(storeErrorMessage({ message: "Failed to fetch" })).toBe("Failed to fetch");
  });
});

describe("the store link", () => {
  it("is idle when empty and sends the origin of any store or product link", () => {
    expect(checkStoreLink("   ")).toEqual({ state: "idle" });
    expect(checkStoreLink("allbirds.com")).toEqual({ state: "ok", url: "https://allbirds.com", key: "allbirds.com", host: "allbirds.com" });
    expect(checkStoreLink(" https://www.Allbirds.com/products/mens-wool-runners?variant=1 ")).toEqual({ state: "ok", url: "https://www.allbirds.com", key: "allbirds.com", host: "www.allbirds.com" });
    expect(checkStoreLink("juniper-goods.myshopify.com/collections/all")).toEqual({ state: "ok", url: "https://juniper-goods.myshopify.com", key: "juniper-goods.myshopify.com", host: "juniper-goods.myshopify.com", handle: "juniper-goods" });
    expect(checkStoreLink("http://shop.example.com/")).toMatchObject({ state: "ok", url: "https://shop.example.com" });
  });

  it("refuses admin links with a plain explanation", () => {
    expect(checkStoreLink("https://admin.shopify.com/store/juniper-goods")).toEqual({ state: "bad", message: ADMIN_LINK_MESSAGE });
    expect(checkStoreLink("juniper-goods.myshopify.com/admin/products")).toEqual({ state: "bad", message: ADMIN_LINK_MESSAGE });
  });

  it("catches obvious typos without a round trip", () => {
    for (const bad of ["not a url", "hello", "allbirds", "ftp://x.myshopify.com", "x..com", "-x.myshopify.com", "x.c0m", "myshopify.com", "shopify.com", "www.shopify.com"]) {
      expect(checkStoreLink(bad).state, bad).toBe("bad");
    }
    const r = checkStoreLink("not a url");
    expect(r.state === "bad" && r.message).toMatch(/allbirds\.com/);
  });

  it("finds a store that is already in the directory by id, handle or domain", () => {
    const dir = [{ id: "acme-pizza" }, { id: "shopify-weareallbirds", shopify: allbirds }];
    expect(existingStore(dir, { handle: "weareallbirds", domain: "weareallbirds.myshopify.com" })?.id).toBe("shopify-weareallbirds");
    expect(existingStore(dir, { handle: "other", domain: "weareallbirds.myshopify.com" })?.id).toBe("shopify-weareallbirds");
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

  it("sends the cap, and connectTo only when someone is picked", () => {
    expect(addStoreBody({ url: "https://www.allbirds.com", cap: "250.00", connectTo: ["agt_1", "agt_1", "agt_2"] })).toEqual({
      url: "https://www.allbirds.com",
      maxPrice: "250.00",
      connectTo: ["agt_1", "agt_2"],
    });
    expect(addStoreBody({ url: "https://b.myshopify.com", connectTo: [] })).toEqual({ url: "https://b.myshopify.com" });
  });

  it("accepts either response shape from the wallet", () => {
    const store = { ...allbirds, name: "Allbirds", currency: "USD" };
    expect(unwrapStore(store)).toEqual(store);
    expect(unwrapStore({ store })).toEqual(store);
    const service = { id: "shopify-weareallbirds", name: "Allbirds" };
    expect(unwrapAdded({ service, agents: [] })).toEqual({ service, agents: [] });
    expect(unwrapAdded(service)).toEqual({ service });
  });
});
