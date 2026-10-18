/**
 * Test double for the Shopify bridge (docs/ARCHITECTURE.md §15.1): discovery and the owner-only store
 * registry, on port 0. Not a test file; imported by the directory and wallet-service tests.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ShopifyStore } from "@allowance/shared";

export interface StubBridge {
  url: string;
  /** Stores discovery can find, by handle. */
  known: Map<string, ShopifyStore>;
  /** Registered stores (POST /stores), by handle. */
  registered: Map<string, ShopifyStore>;
  calls: { method: string; path: string; ownerKey?: string; body?: unknown }[];
  /** Force every response to this status (e.g. 500) until cleared. */
  failWith?: number;
  close(): Promise<void>;
}

export const CRYPTO_STORE: ShopifyStore = {
  handle: "crypto-app-test",
  domain: "crypto-app-test.myshopify.com",
  mode: "agent_checkout",
  name: "Crypto App Test",
  currency: "USD",
  productCount: 12,
};

export const HANDOFF_STORE: ShopifyStore = {
  handle: "cool-socks",
  domain: "cool-socks.myshopify.com",
  mode: "handoff",
  name: "Cool Socks",
  currency: "USD",
  productCount: 40,
};

export const EURO_STORE: ShopifyStore = { handle: "euro-shop", domain: "euro-shop.myshopify.com", mode: "handoff", name: "Euro Shop", currency: "EUR" };

/** "https://x.myshopify.com/...", "x.myshopify.com" or a storefront alias in `aliases` → handle. */
function handleOf(raw: string, aliases: Record<string, string>): string | null {
  const s = raw.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  if (aliases[host]) return aliases[host];
  const m = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(host);
  return m ? m[1] : null;
}

export async function startStubBridge(opts: { ownerKey?: string; stores?: ShopifyStore[]; aliases?: Record<string, string> } = {}): Promise<StubBridge> {
  const aliases = { "shop.crypto.example": "crypto-app-test", ...(opts.aliases ?? {}) };
  const stub: StubBridge = {
    url: "",
    known: new Map((opts.stores ?? [CRYPTO_STORE, HANDOFF_STORE, EURO_STORE]).map((s) => [s.handle, s])),
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
    const handle = typeof raw === "string" ? handleOf(raw, aliases) : null;
    if (!handle) {
      res.status(400).json({ error: "invalid_store_url", message: "That is not a Shopify store link" });
      return null;
    }
    const store = stub.known.get(handle);
    if (!store) {
      res.status(404).json({ error: "store_not_found", message: `No Shopify store at ${handle}.myshopify.com` });
      return null;
    }
    if (store.currency !== "USD") {
      res.status(422).json({ error: "store_unsupported", message: `${store.name} prices in ${store.currency}; only USD stores are supported` });
      return null;
    }
    return store;
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
    if (existing) return void res.status(409).json({ error: "store_exists", message: "Already registered", store: existing });
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
