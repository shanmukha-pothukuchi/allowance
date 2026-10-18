/**
 * Test double for the Shopify bridge (docs/ARCHITECTURE.md §15.1): discovery and the owner-only store
 * registry, on port 0. Not a test file; imported by the directory and wallet-service tests.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ShopifyStore } from "@allowance/shared";

export interface StubStore extends ShopifyStore {
  /** Password-protected storefront: discovery answers 422 private_catalog. */
  private?: boolean;
}

export interface StubBridge {
  url: string;
  /** Stores discovery can find, by handle. */
  known: Map<string, StubStore>;
  /** Registered stores (POST /stores), by handle. */
  registered: Map<string, ShopifyStore>;
  calls: { method: string; path: string; ownerKey?: string; body?: unknown }[];
  /** Force every response to this status (e.g. 500) until cleared. */
  failWith?: number;
  close(): Promise<void>;
}

/** A public store on a custom domain that takes agent card checkout (like the real Allbirds). */
export const ALLBIRDS_STORE: ShopifyStore = {
  handle: "weareallbirds",
  domain: "weareallbirds.myshopify.com",
  storefrontUrl: "https://www.allbirds.com",
  cardCheckout: true,
  name: "Allbirds",
  currency: "USD",
  sampleImages: ["https://cdn.shopify.com/s/files/1/runner_480x.png", "https://cdn.shopify.com/s/files/1/loafer_480x.png"],
  productCount: 692,
};

/** A public store on its myshopify address that doesn't advertise card checkout for agents. */
export const SOCKS_STORE: ShopifyStore = {
  handle: "cool-socks",
  domain: "cool-socks.myshopify.com",
  storefrontUrl: "https://cool-socks.myshopify.com",
  cardCheckout: false,
  name: "Cool Socks",
  currency: "USD",
  productCount: 40,
};

export const EURO_STORE: ShopifyStore = {
  handle: "euro-shop",
  domain: "euro-shop.myshopify.com",
  storefrontUrl: "https://www.euroshop.example",
  cardCheckout: true,
  name: "Euro Shop",
  currency: "EUR",
};

/** A fresh dev store with its storefront password on (like crypto-app-test). */
export const PRIVATE_STORE: StubStore = {
  handle: "crypto-app-test",
  domain: "crypto-app-test.myshopify.com",
  storefrontUrl: "https://crypto-app-test.myshopify.com",
  cardCheckout: false,
  name: "crypto-app-test",
  currency: "USD",
  private: true,
};

/** "https://x.myshopify.com/...", "x.myshopify.com" or a storefront alias in `aliases` → handle. */
function handleOf(raw: string, aliases: Record<string, string>): string | null {
  const s = raw.trim().toLowerCase();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.hostname === "admin.shopify.com") return null;
  if (aliases[url.hostname]) return aliases[url.hostname];
  const m = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(url.hostname);
  return m ? m[1] : null;
}

export async function startStubBridge(opts: { ownerKey?: string; stores?: StubStore[]; aliases?: Record<string, string> } = {}): Promise<StubBridge> {
  const aliases = { "allbirds.com": "weareallbirds", "www.allbirds.com": "weareallbirds", "www.euroshop.example": "euro-shop", ...(opts.aliases ?? {}) };
  const stub: StubBridge = {
    url: "",
    known: new Map((opts.stores ?? [ALLBIRDS_STORE, SOCKS_STORE, EURO_STORE, PRIVATE_STORE]).map((s) => [s.handle, s])),
    registered: new Map(),
    calls: [],
    close: async () => {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    stub.calls.push({ method: req.method, path: req.originalUrl, ownerKey: req.header("x-owner-key") ?? undefined, body: req.body });
    if (stub.failWith) return void res.status(stub.failWith).json({ error: "boom", message: "bridge exploded" });
    next();
  });

  const lookup = (raw: unknown, res: express.Response): ShopifyStore | null => {
    if (typeof raw === "string" && /admin\.shopify\.com/i.test(raw)) {
      res.status(400).json({ error: "invalid_store_url", message: "That's a store admin link; paste the shop's own address (like allbirds.com or a product page) instead." });
      return null;
    }
    const handle = typeof raw === "string" ? handleOf(raw, aliases) : null;
    if (!handle) {
      res.status(400).json({ error: "invalid_store_url", message: "That isn't a store link. Paste the shop's address, like allbirds.com, one of its product pages, or your-store.myshopify.com." });
      return null;
    }
    const store = stub.known.get(handle);
    if (!store) {
      res.status(404).json({ error: "store_not_found", message: `There's no Shopify store at ${handle}.myshopify.com.` });
      return null;
    }
    if (store.private) {
      res.status(422).json({ error: "store_unsupported", reason: "private_catalog", message: "This store's catalog isn't public yet (it's password-protected), so agents can't browse it." });
      return null;
    }
    if (store.currency !== "USD") {
      res.status(422).json({ error: "store_unsupported", reason: "currency", currency: store.currency, message: `${store.name} doesn't sell to US shoppers in US dollars (it prices in ${store.currency}), so agents can't pay it in USDC.` });
      return null;
    }
    const { private: _private, ...pub } = store;
    return pub;
  };

  app.get("/stores/discover", (req, res) => {
    const store = lookup(req.query.url, res);
    if (store) res.json(store);
  });

  app.post("/stores", (req, res) => {
    if (opts.ownerKey && req.header("x-owner-key") !== opts.ownerKey) return void res.status(401).json({ error: "unauthorized", message: "X-Owner-Key required" });
    const store = lookup(req.body?.url, res);
    if (!store) return;
    const existing = stub.registered.get(store.handle);
    if (existing) return void res.status(409).json({ error: "store_exists", message: "Already added", store: existing });
    const added = { ...store, addedAt: new Date().toISOString() };
    stub.registered.set(store.handle, added);
    res.status(201).json({ store: added });
  });

  app.get("/stores", (_req, res) => {
    res.json({ stores: [...stub.registered.values()] });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
