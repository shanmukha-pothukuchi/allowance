/**
 * Test doubles: a scripted wallet-service and an x402 + agent-work merchant, both on port 0.
 * Not a test file (no .test.ts) — imported by server.test.ts.
 */
import express from "express";
import type { Server } from "node:http";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type {
  AgentWorkDoc,
  ApprovalWaitResponse,
  ClaimResponse,
  ConnectedService,
  EarningRequest,
  MeResponse,
  PayRequest,
  PayResponse,
  PayoutResponse,
  Receipt,
  ServiceGrant,
  ServiceManifest,
  ServiceRequest,
  ServiceRequestResponse,
  ShopifyStore,
  TransferRequest,
  TransferResponse,
} from "@allowance/shared";
// Relative on purpose (like the agents' seeds): Shopify manifests built exactly as the directory builds them.
import { shopifyManifest } from "../../directory/src/shopify.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532" as const;

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------- wallet stub

/** One agent behind a stub token. */
export interface StubAgent {
  id: string;
  name: string;
  services: ConnectedService[];
  /** MeResponse.bank (Capital One allowance account, §16); absent = bank not linked. */
  bank?: MeResponse["bank"];
}

export interface StubApproval {
  status: "pending" | "approved" | "denied" | "expired";
  /** "payment" (default) or "service". */
  kind?: "payment" | "service";
  paymentId: string;
  paymentHeader?: string;
  /** Payment approvals only. */
  receipt?: Receipt;
  /** Service approvals only. */
  service?: ServiceGrant;
  /** Service approvals only: the token whose agent gets the connection. */
  token?: string;
  /** Service approvals only: docs from a custom proposal. */
  docs?: string;
  /** Service approvals only: the connection made on approval. */
  connected?: ConnectedService;
  /** Shopify only: a store the agent found; approving adds this manifest to the stub directory. */
  newShopify?: ServiceManifest;
}

/** Stores the stub "bridge" can discover (ARCHITECTURE §15.1). None is in the directory until added. */
export const STUB_SHOPIFY_STORES: (ShopifyStore & { private?: boolean })[] = [
  { handle: "weareallbirds", domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com", cardCheckout: true, name: "Allbirds", currency: "USD", productCount: 692 },
  { handle: "cool-socks", domain: "cool-socks.myshopify.com", storefrontUrl: "https://cool-socks.myshopify.com", cardCheckout: false, name: "Cool Socks", currency: "USD", productCount: 40 },
  { handle: "euro-shop", domain: "euro-shop.myshopify.com", storefrontUrl: "https://euro-shop.myshopify.com", cardCheckout: true, name: "Euro Shop", currency: "EUR" },
  { handle: "crypto-app-test", domain: "crypto-app-test.myshopify.com", storefrontUrl: "https://crypto-app-test.myshopify.com", cardCheckout: false, name: "crypto-app-test", currency: "USD", private: true },
];
/** Custom storefront domains the stub "bridge" resolves (as /.well-known/ucp would). */
const STUB_SHOPIFY_ALIASES: Record<string, string> = { "allbirds.com": "weareallbirds", "www.allbirds.com": "weareallbirds" };

/**
 * The stub directory: the directory itself plus three services on the merchant stub.
 * acme-weather and acme-pizza are connected to the default token; acme-stocks is not (it
 * answers `service_not_connected` on /v1/pay until requested and approved).
 */
export function stubDirectory(merchantUrl: string, walletUrl = ""): ServiceManifest[] {
  const m = merchantUrl.replace(/\/+$/, "");
  return [
    {
      id: "directory",
      name: "Service Directory",
      provider: "Allowance",
      icon: "🗂️",
      color: "#64748B",
      category: "tools",
      kind: "directory",
      summary: "Find services and ask your owner to connect them.",
      description: "The catalog of services agents can connect. Always available.",
      baseUrl: `${walletUrl}/v1/directory`,
      pricing: "Free",
      maxPrice: "0.00",
      permissions: ["Read the service catalog"],
      docs: "Use search_services, get_service and request_service.",
      source: "directory",
    },
    {
      id: "acme-weather",
      name: "Acme Weather",
      provider: "Acme Corp",
      icon: "🌤️",
      color: "#3AA0E0",
      category: "data",
      kind: "x402",
      summary: "Current weather for any city.",
      description: "Temperature and a one-word summary for a city.",
      baseUrl: `${m}/api/weather`,
      pricing: "$0.05 per call",
      maxPrice: "0.05",
      permissions: ["Pay up to $0.05 per call to Acme Weather"],
      docs: `GET ${m}/api/weather?city=Berlin -> { city, tempC, summary }`,
      source: "directory",
    },
    {
      id: "acme-stocks",
      name: "Acme Stocks",
      provider: "Acme Corp",
      icon: "📈",
      color: "#2F9E5B",
      category: "data",
      kind: "x402",
      summary: "Latest price for a stock symbol.",
      description: "Price and daily change for a ticker.",
      baseUrl: `${m}/api/stock`,
      pricing: "$0.15 per call",
      maxPrice: "0.15",
      permissions: ["Pay up to $0.15 per call to Acme Stocks"],
      docs: `GET ${m}/api/stock?symbol=ACME -> { symbol, price, change }`,
      source: "directory",
    },
    {
      id: "acme-pizza",
      name: "Acme Pizza",
      provider: "Acme Corp",
      icon: "🍕",
      color: "#E5527A",
      category: "shopping",
      kind: "x402",
      summary: "Order a pizza (fulfillment simulated).",
      description: "Pick a size and toppings; a simulated order is placed.",
      baseUrl: `${m}/pizza`,
      pricing: "$18.50 per order",
      maxPrice: "18.50",
      permissions: ["Pay up to $18.50 per order to Acme Pizza"],
      docs: `POST ${m}/pizza/order { size, toppings[], address } -> { orderId, status, eta }`,
      source: "directory",
    },
  ];
}

function toGrant(m: ServiceManifest): ServiceGrant {
  const { id, name, provider, icon, color, kind, summary, baseUrl, pricing, maxPrice, permissions, source, shopify } = m;
  return { id, name, provider, icon, color, kind, summary, baseUrl, pricing, maxPrice, permissions, source, ...(shopify ? { shopify } : {}) };
}

/** Path-boundary prefix match, like the real wallet's connected-service check. */
function underBase(url: string, base: string): boolean {
  if (!base) return false;
  const b = base.replace(/\/+$/, "");
  return url === b || url.startsWith(`${b}/`) || url.startsWith(`${b}?`);
}

export interface WalletStub {
  url: string;
  token: string;
  address: `0x${string}`;
  /** Amount in dollars (number) at or below which payments are approved outright. */
  approveUpTo: number;
  /** Amount in dollars above which payments are blocked (between approveUpTo and this → needs_approval). */
  blockAbove: number;
  /** If set, pending approvals auto-approve after this many ms. null = stay pending until approve() is called. */
  autoApproveAfterMs: number | null;
  frozen: boolean;
  receipts: Receipt[];
  payRequests: PayRequest[];
  settledCalls: { paymentId: string; body: unknown }[];
  earnings: EarningRequest[];
  transfers: TransferRequest[];
  approvals: Map<string, StubApproval>;
  /** Base URL the stub directory points at (set it to the merchant stub's url). */
  merchantUrl: string;
  /** Agents by token. The default `token` is "claude-desktop". */
  agents: Map<string, StubAgent>;
  serviceRequests: ServiceRequest[];
  /** Shopify stores discovery can find (by handle). Defaults to STUB_SHOPIFY_STORES. */
  shopifyStores: Map<string, ShopifyStore & { private?: boolean }>;
  /** Directory entries added at runtime (Shopify stores), listed after the built-in ones. */
  extraServices: ServiceManifest[];
  /** Add a discoverable Shopify store to the directory (as the owner would), with its cap. */
  addShopifyStore(handle: string, maxPrice?: string): ServiceManifest | undefined;
  directory(): ServiceManifest[];
  /** Add another agent token with these directory services connected (connectedBy "default"). */
  addToken(name: string, serviceIds?: string[]): string;
  /** Connect a directory service to a token's agent directly (like the owner would). */
  connect(token: string, serviceId: string, by?: ConnectedService["connectedBy"]): ConnectedService | undefined;
  approve(approvalId: string): void;
  deny(approvalId: string): void;
  close(): Promise<void>;
}

let seq = 0;
const nid = (p: string) => `${p}_${(++seq).toString(16).padStart(6, "0")}`;

export interface WalletStubOptions extends Partial<Pick<WalletStub, "approveUpTo" | "blockAbove" | "autoApproveAfterMs" | "merchantUrl">> {
  /** Directory services connected to the default token. Default ["acme-weather", "acme-pizza"]. */
  connected?: string[];
}

export async function startWalletStub(opts: WalletStubOptions = {}): Promise<WalletStub> {
  const token = "aw_" + "ab".repeat(24);
  const address = "0x1111111111111111111111111111111111111111" as const;
  let tokenSeq = 0;
  const stub: WalletStub = {
    url: "",
    token,
    address,
    approveUpTo: opts.approveUpTo ?? 5,
    blockAbove: opts.blockAbove ?? 10,
    autoApproveAfterMs: opts.autoApproveAfterMs ?? null,
    frozen: false,
    receipts: [],
    payRequests: [],
    settledCalls: [],
    earnings: [],
    transfers: [],
    approvals: new Map(),
    merchantUrl: opts.merchantUrl ?? "",
    agents: new Map(),
    serviceRequests: [],
    shopifyStores: new Map(STUB_SHOPIFY_STORES.map((x) => [x.handle, x])),
    extraServices: [],
    addShopifyStore(handle, maxPrice) {
      const store = stub.shopifyStores.get(handle);
      if (!store) return undefined;
      const existing = stub.extraServices.find((m) => m.id === `shopify-${handle}`);
      if (existing) return existing;
      // The merchant stub plays the bridge: its /shops/<handle>/… routes serve products, carts and checkout.
      const m = shopifyManifest(store, { bridgeUrl: stub.merchantUrl, maxPrice });
      stub.extraServices.push(m);
      return m;
    },
    directory: () => [...stubDirectory(stub.merchantUrl, stub.url), ...stub.extraServices],
    addToken(name, serviceIds = []) {
      const t = `aw_${(++tokenSeq).toString(16).padStart(4, "0")}${"cd".repeat(22)}`;
      stub.agents.set(t, { id: `agt_${name}`, name, services: [] });
      for (const sid of serviceIds) stub.connect(t, sid, "default");
      return t;
    },
    connect(t, serviceId, by = "owner") {
      const agent = stub.agents.get(t);
      const m = stub.directory().find((s) => s.id === serviceId);
      if (!agent || !m) return undefined;
      const existing = agent.services.find((c) => c.id === serviceId);
      if (existing) return existing;
      const c: ConnectedService = { ...toGrant(m), connectedAt: new Date().toISOString(), connectedBy: by };
      agent.services.push(c);
      return c;
    },
    approve(id) {
      const a = stub.approvals.get(id);
      if (!a || a.status !== "pending") return;
      a.status = "approved";
      if (a.kind === "service") {
        const agent = a.token ? stub.agents.get(a.token) : undefined;
        // A store the agent found joins the directory first; the connection then comes from there.
        if (a.newShopify && !stub.extraServices.some((m) => m.id === a.newShopify!.id)) stub.extraServices.push(a.newShopify);
        if (agent && a.service) {
          const grant: ServiceGrant = a.newShopify ? { ...a.service, source: "directory" } : a.service;
          const c: ConnectedService = { ...grant, connectedAt: new Date().toISOString(), connectedBy: "approval", ...(a.docs ? { docs: a.docs } : {}) };
          agent.services = [...agent.services.filter((x) => x.id !== c.id), c];
          a.connected = c;
        }
        return;
      }
      a.paymentHeader = a.paymentHeader === undefined ? undefined : `hdr_${id}`;
      if (!a.receipt) return;
      a.receipt.status = a.paymentHeader ? "signed" : "settled";
      if (!a.paymentHeader) {
        a.receipt.txHash = `0x${"c".repeat(64)}`;
        a.receipt.explorerUrl = `http://explorer.test/tx/${a.receipt.txHash}`;
      }
    },
    deny(id) {
      const a = stub.approvals.get(id);
      if (!a || a.status !== "pending") return;
      a.status = "denied";
      if (a.receipt) a.receipt.status = "denied";
    },
    close: async () => {},
  };

  const app = express();
  app.use(express.json());
  stub.agents.set(token, { id: "agt_test", name: "claude-desktop", services: [] });
  app.use((req, res, next) => {
    const auth = req.headers.authorization ?? "";
    const agent = auth.startsWith("Bearer ") ? stub.agents.get(auth.slice(7)) : undefined;
    if (!agent) {
      res.status(401).json({ error: "unauthorized", message: "bad token" });
      return;
    }
    res.locals.token = auth.slice(7);
    res.locals.agent = agent;
    next();
  });
  const agentOf = (res: express.Response) => res.locals.agent as StubAgent;

  const mkReceipt = (kind: Receipt["kind"], amount: string, description: string, extra: Partial<Receipt> = {}): Receipt => {
    const r: Receipt = {
      id: nid("rcp"),
      kind,
      status: "signed",
      agentId: "agt_test",
      agentName: "claude-desktop",
      description,
      amount,
      amountBaseUnits: String(Math.round(Number(amount) * 1e6)),
      counterparty: { address: "0x2222222222222222222222222222222222222222", name: description },
      network: NETWORK,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    stub.receipts.push(r);
    return r;
  };

  const me = (agent: StubAgent): MeResponse => ({
    agent: {
      id: agent.id,
      name: agent.name,
      address,
      services: agent.services,
      policy: { maxPerTx: "20.00", dailyCap: "50.00", allowlist: { addresses: [], origins: ["http://localhost:4021"] }, approvalThreshold: "10.00", frozen: stub.frozen, freezeOnViolation: true },
      createdAt: new Date().toISOString(),
      balance: "20.00",
      spentToday: "0.05",
      earnedToday: "0.50",
      frozen: stub.frozen,
    },
    limits: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", remainingToday: "49.95" },
    ...(agent.bank ? { bank: agent.bank } : {}),
  });

  app.get("/v1/me", (_req, res) => {
    res.json(me(agentOf(res)));
  });

  function decide(amountDollars: number, description: string, counterpartyName: string, kind: "spend" | "transfer", isX402: boolean): { status: number; body: PayResponse | TransferResponse } {
    const amount = amountDollars.toFixed(2);
    const paymentId = nid("pay");
    if (stub.frozen) {
      const receipt = mkReceipt(kind, amount, description, { status: "blocked", reason: "frozen", paymentId });
      return { status: 403, body: { status: "blocked", reason: "frozen", message: "Blocked: agent is frozen.", frozen: true, receipt } };
    }
    if (amountDollars > stub.blockAbove) {
      stub.frozen = true;
      const receipt = mkReceipt(kind, amount, description, { status: "blocked", reason: "max_per_tx", paymentId });
      return {
        status: 403,
        body: { status: "blocked", reason: "max_per_tx", message: `Blocked: tried to send $${amount} to ${counterpartyName}, over the $${stub.blockAbove.toFixed(2)} per-payment limit. Agent frozen.`, frozen: true, receipt },
      };
    }
    if (amountDollars > stub.approveUpTo) {
      const approvalId = nid("apr");
      const receipt = mkReceipt(kind, amount, description, { status: "pending_approval", paymentId, approvalId });
      stub.approvals.set(approvalId, { status: "pending", paymentId, paymentHeader: isX402 ? "" : undefined, receipt });
      if (stub.autoApproveAfterMs !== null) setTimeout(() => stub.approve(approvalId), stub.autoApproveAfterMs);
      const message = `Needs owner approval: $${amount} to ${counterpartyName}.`;
      if (isX402) return { status: 202, body: { status: "needs_approval", paymentId, approvalId, amount, message, receipt } };
      return { status: 202, body: { status: "needs_approval", approvalId, amount, message, receipt } };
    }
    if (isX402) {
      const receipt = mkReceipt(kind, amount, description, { status: "signed", paymentId });
      return { status: 200, body: { status: "approved", paymentId, paymentHeader: `hdr_${paymentId}`, receipt } };
    }
    const txHash = `0x${"d".repeat(64)}` as const;
    const receipt = mkReceipt(kind, amount, description, { status: "settled", txHash, explorerUrl: `http://explorer.test/tx/${txHash}`, settledAt: new Date().toISOString() });
    return { status: 200, body: { status: "sent", receipt } };
  }

  app.post("/v1/pay", (req, res) => {
    const body = req.body as PayRequest;
    stub.payRequests.push(body);
    const amountDollars = Number(body.paymentRequired.accepts[0].amount) / 1e6;
    // A directory service this agent has not connected: soft block, no freeze (ARCHITECTURE §13.2).
    const agent = agentOf(res);
    const svc = stub.directory().find((s) => s.kind === "x402" && underBase(body.url, s.baseUrl));
    if (svc && !agent.services.some((c) => c.id === svc.id)) {
      const receipt = mkReceipt("spend", amountDollars.toFixed(2), body.description ?? svc.name, { status: "blocked", reason: "service_not_connected", paymentId: nid("pay") });
      const out: PayResponse = { status: "blocked", reason: "service_not_connected", message: `${svc.name} is not connected for ${agent.name}. Ask the owner with request_service.`, frozen: false, receipt };
      res.status(403).json(out);
      return;
    }
    const d = decide(amountDollars, body.description ?? body.url, body.description ?? body.url, "spend", true);
    res.status(d.status).json(d.body);
  });

  app.post("/v1/payments/:paymentId/settled", (req, res) => {
    stub.settledCalls.push({ paymentId: req.params.paymentId as string, body: req.body });
    const r = stub.receipts.find((x) => x.paymentId === req.params.paymentId);
    if (!r) {
      res.status(404).json({ error: "payment_not_found", message: "unknown payment" });
      return;
    }
    const tx = (req.body as { settleResponse: { transaction: string; success: boolean } }).settleResponse;
    r.status = tx.success ? "settled" : "failed";
    r.txHash = tx.transaction as `0x${string}`;
    r.explorerUrl = `http://explorer.test/tx/${tx.transaction}`;
    r.settledAt = new Date().toISOString();
    res.json({ receipt: r });
  });

  app.post("/v1/transfer", (req, res) => {
    const body = req.body as TransferRequest;
    stub.transfers.push(body);
    const d = decide(Number(body.amount), body.memo ?? "Transfer", body.to, "transfer", false);
    (d.body as { receipt: Receipt }).receipt.counterparty = { address: body.to };
    res.status(d.status).json(d.body);
  });

  app.get("/v1/approvals/:id/wait", async (req, res) => {
    const id = req.params.id as string;
    const timeoutMs = Number(req.query.timeoutMs ?? 45000);
    const started = Date.now();
    const a = stub.approvals.get(id);
    if (!a) {
      res.status(404).json({ error: "approval_not_found", message: "unknown approval" });
      return;
    }
    while (a.status === "pending" && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    let out: ApprovalWaitResponse;
    const kind = a.kind === "service" ? "service" : "payment";
    // Like the wallet: service approvals carry the grant in every state.
    const svc = kind === "service" && a.service ? { service: a.service } : {};
    if (a.status === "pending") out = { status: "pending", approvalId: id, kind, ...svc };
    else if (a.status === "denied") out = kind === "service" ? { status: "denied", approvalId: id, kind, ...svc } : { status: "denied", approvalId: id, kind, receipt: a.receipt };
    else if (a.status === "expired") out = { status: "expired", approvalId: id, kind, ...svc };
    else if (kind === "service") out = { status: "approved", approvalId: id, kind, paymentId: "", service: a.connected };
    else out = { status: "approved", approvalId: id, kind, paymentId: a.paymentId, paymentHeader: a.paymentHeader || undefined, receipt: a.receipt };
    res.json(out);
  });

  // ---- services (ARCHITECTURE §13.2)
  const withoutDocs = (m: ServiceManifest, agent: StubAgent) => {
    const { docs: _docs, ...rest } = m;
    return { ...rest, connected: agent.services.some((c) => c.id === m.id) };
  };

  app.get("/v1/services", (_req, res) => {
    res.json({ connected: agentOf(res).services, directoryUrl: `${stub.url}/v1/directory` });
  });

  app.get("/v1/directory", (req, res) => {
    const agent = agentOf(res);
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const all = stub.directory().filter((m) => !q || [m.name, m.summary, m.description, m.provider, m.category].some((f) => f.toLowerCase().includes(q)));
    res.json({ services: all.map((m) => withoutDocs(m, agent)) });
  });

  app.get("/v1/directory/:id", (req, res) => {
    const agent = agentOf(res);
    const id = req.params.id as string;
    const m = stub.directory().find((s) => s.id === id);
    if (m) return void res.json({ ...m, connected: agent.services.some((c) => c.id === id) });
    const custom = agent.services.find((c) => c.id === id && c.source === "agent");
    if (custom) {
      return void res.json({ ...custom, category: "tools", description: custom.summary, docs: custom.docs ?? "", connected: true });
    }
    res.status(404).json({ error: "service_not_found", message: `No service ${id}` });
  });

  app.post("/v1/services/requests", (req, res) => {
    const body = (req.body ?? {}) as ServiceRequest;
    stub.serviceRequests.push(body);
    const agent = agentOf(res);
    let grant: ServiceGrant;
    let newShopify: ServiceManifest | undefined;
    if (body.shopifyStoreUrl) {
      // ARCHITECTURE §15.3: discover via the bridge; listed → normal request; otherwise ask to add it.
      const host = (() => {
        try {
          const raw = String(body.shopifyStoreUrl).trim().toLowerCase();
          return new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
        } catch {
          return "";
        }
      })();
      if (host === "admin.shopify.com") {
        return void res.status(400).json({ error: "invalid_store_url", message: "That's a store admin link; paste the shop's own address (like allbirds.com or a product page) instead." });
      }
      const handle = STUB_SHOPIFY_ALIASES[host] ?? /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(host)?.[1];
      if (!handle) {
        return void res.status(400).json({ error: "invalid_store_url", message: "That isn't a store link. Paste the shop's address, like allbirds.com, one of its product pages, or your-store.myshopify.com." });
      }
      const found = stub.shopifyStores.get(handle);
      if (!found) return void res.status(404).json({ error: "store_not_found", message: `There's no Shopify store at ${handle}.myshopify.com.` });
      if (found.private) {
        return void res.status(422).json({ error: "store_unsupported", message: "This store's catalog isn't public yet (it's password-protected), so agents can't browse it.", details: { reason: "private_catalog" } });
      }
      if (found.currency !== "USD") {
        return void res.status(422).json({ error: "store_unsupported", message: `${found.name} doesn't sell to US shoppers in US dollars (it prices in ${found.currency}), so agents can't pay it in USDC.`, details: { reason: "currency" } });
      }
      const { private: _private, ...store } = found;
      const cap = body.maxPrice ?? "20.00";
      if (!/^\d+(\.\d{1,2})?$/.test(cap) || Number(cap) > 20) {
        return void res.status(400).json({ error: "invalid_request", message: `maxPrice $${cap} is over this agent's $20.00 per-payment limit` });
      }
      const id = `shopify-${handle}`;
      const existing = agent.services.find((c) => c.id === id);
      if (existing) return void res.json({ status: "connected", service: existing } satisfies ServiceRequestResponse);
      const listed = stub.directory().find((m) => m.id === id);
      if (listed) grant = toGrant(listed);
      else {
        newShopify = shopifyManifest(store, { bridgeUrl: stub.merchantUrl, maxPrice: cap });
        grant = { ...toGrant(newShopify), source: "agent" };
      }
    } else if (body.serviceId) {
      const m = stub.directory().find((s) => s.id === body.serviceId);
      if (!m) return void res.status(404).json({ error: "service_not_found", message: `No service ${body.serviceId} in the directory` });
      if (m.kind === "directory") return void res.status(400).json({ error: "invalid_request", message: "The directory is always available" });
      const existing = agent.services.find((c) => c.id === m.id);
      if (existing) return void res.json({ status: "connected", service: existing } satisfies ServiceRequestResponse);
      grant = toGrant(m);
    } else if (body.custom) {
      const c = body.custom;
      const bad = !/^https?:\/\//.test(c.baseUrl ?? "") ? "baseUrl must be http(s)" : !c.name || c.name.length > 60 ? "name must be 1-60 characters" : (c.summary ?? "").length > 200 ? "summary must be at most 200 characters" : !(Number(c.maxPrice) >= 0 && Number(c.maxPrice) <= 20) ? "maxPrice must be at most your max per payment ($20.00)" : "";
      if (bad) return void res.status(400).json({ error: "invalid_request", message: bad });
      const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      grant = { id: `custom-${slug}`, name: c.name, provider: "Proposed by agent", icon: "🧩", color: "#7C8799", kind: "x402", summary: c.summary, baseUrl: c.baseUrl, pricing: `Up to $${Number(c.maxPrice).toFixed(2)} per payment`, maxPrice: Number(c.maxPrice).toFixed(2), permissions: [`Pay up to $${Number(c.maxPrice).toFixed(2)} per request under ${c.baseUrl}`], source: "agent" };
    } else {
      return void res.status(400).json({ error: "invalid_request", message: "Give serviceId or custom" });
    }
    const approvalId = nid("apr");
    stub.approvals.set(approvalId, { status: "pending", kind: "service", paymentId: "", service: grant, token: res.locals.token as string, docs: body.custom?.docs, newShopify });
    if (stub.autoApproveAfterMs !== null) setTimeout(() => stub.approve(approvalId), stub.autoApproveAfterMs);
    const out: ServiceRequestResponse = { status: "needs_approval", approvalId, service: grant, message: `${agent.name} wants to connect ${grant.name}.` };
    res.status(202).json(out);
  });

  app.post("/v1/earnings", (req, res) => {
    const body = req.body as EarningRequest;
    stub.earnings.push(body);
    const r = mkReceipt("earn", body.amount, body.description, {
      status: "settled",
      txHash: body.txHash,
      explorerUrl: `http://explorer.test/tx/${body.txHash}`,
      counterparty: { address: body.from.address ?? "0x3333333333333333333333333333333333333333", origin: body.from.origin, name: body.from.name },
      settledAt: new Date().toISOString(),
    });
    res.json({ receipt: r });
  });

  app.get("/v1/receipts", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ receipts: stub.receipts.slice(-limit).reverse() });
  });

  const { server, url } = await listen(app);
  stub.url = url;
  for (const sid of opts.connected ?? ["acme-weather", "acme-pizza"]) stub.connect(token, sid, "default");
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

// ---------------------------------------------------------------------------- merchant stub

export interface MerchantStub {
  url: string;
  claims: Map<string, { bountyId: string; walletAddress: string; expiresAt: string; paid?: PayoutResponse }>;
  submits: unknown[];
  paidRequests: { path: string; signature: string }[];
  slotsRemaining: number;
  close(): Promise<void>;
}

export async function startMerchantStub(): Promise<MerchantStub> {
  const stub: MerchantStub = { url: "", claims: new Map(), submits: [], paidRequests: [], slotsRemaining: 3, close: async () => {} };
  const app = express();
  app.use(express.json());

  const paid = (path: string, amountBaseUnits: string, serviceName: string, handler: (req: express.Request) => unknown) => {
    const route = (req: express.Request, res: express.Response) => {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        res.setHeader(
          "PAYMENT-REQUIRED",
          encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: `${stub.url}${path}`, description: serviceName, serviceName: "Acme APIs" },
            accepts: [{ scheme: "exact", network: NETWORK, amount: amountBaseUnits, asset: USDC, payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }],
          }),
        );
        res.status(402).json({});
        return;
      }
      stub.paidRequests.push({ path, signature: String(sig) });
      const tx = `0x${"a".repeat(60)}${stub.paidRequests.length.toString(16).padStart(4, "0")}`;
      res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader({ success: true, transaction: tx, network: NETWORK, payer: "0x1111111111111111111111111111111111111111" }));
      res.json(handler(req));
    };
    app.get(path, route);
    app.post(path, route);
  };

  paid("/api/weather", "50000", "Acme Weather", (req) => ({ city: req.query.city ?? "Berlin", tempC: 17, summary: "cloudy" }));
  paid("/pizza/order", "8000000", "Pizza Co", (req) => ({ orderId: "ord_1", status: "placed", eta: "25 min", size: req.body?.size ?? "large", simulated: true }));
  paid("/api/expensive", "50000000", "Gold Plated API", () => ({ gold: true }));
  paid("/api/stock", "150000", "Acme Stocks", (req) => ({ symbol: req.query.symbol ?? "ACME", price: 101.5, change: 0.8 }));

  // ---- a tiny Shopify bridge (ARCHITECTURE §15.1) for Allbirds: products, a cart, paid checkout → simulated confirmation
  const socks = {
    id: "gid://shopify/Product/1",
    handle: "anytime-ankle-sock",
    title: "Anytime Ankle Sock",
    description: "Soft, breathable socks.",
    image: "https://cdn.shopify.com/s/files/1/sock_640x.png",
    url: "https://www.allbirds.com/products/anytime-ankle-sock",
    priceMin: "4.00",
    priceMax: "4.00",
    currency: "USD",
    available: true,
    variants: [{ id: "gid://shopify/ProductVariant/11", title: "M", price: "4.00", available: true }],
  };
  const shopInfo = { name: "Allbirds", storefrontUrl: "https://www.allbirds.com", currency: "USD" };
  const line = { variantId: socks.variants[0].id, title: socks.title, variantTitle: "M", quantity: 1, unitPrice: "4.00", lineTotal: "4.00", image: socks.image, url: socks.url };
  app.get("/shops/weareallbirds/products", (_req, res) => {
    res.json({ store: shopInfo, products: [socks] });
  });
  app.post("/shops/weareallbirds/carts", (req, res) => {
    const lines = (req.body?.lines ?? []) as { variantId: string; quantity: number }[];
    if (lines.length !== 1 || lines[0].variantId !== socks.variants[0].id || lines[0].quantity !== 1) {
      return void res.status(400).json({ error: "invalid_request", message: "This stub sells exactly one pair of socks" });
    }
    res.status(201).json({
      cartId: "cart_1",
      store: { handle: "weareallbirds", domain: "weareallbirds.myshopify.com", cardCheckout: true, ...shopInfo },
      lines: [line],
      subtotal: "4.00",
      total: "4.00",
      currency: "USD",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      checkoutUrl: `${stub.url}/shops/weareallbirds/carts/cart_1/checkout`,
      shopifyCheckoutUrl: "https://www.allbirds.com/cart/c/c1?key=k1",
      notes: ["Shipping and taxes are added at checkout"],
    });
  });
  paid("/shops/weareallbirds/carts/cart_1/checkout", "4000000", "Allbirds order", () => ({
    status: "placed",
    simulated: true,
    reference: "ALW-7K3Q-M9XD",
    store: { name: "Allbirds", storefrontUrl: "https://www.allbirds.com" },
    items: [line],
    total: "4.00",
    currency: "USD",
    card: { brand: "Allowance Card", last4: "4821" },
    paidAt: new Date().toISOString(),
    explanation: "For a real order, Allowance would issue a single-use card for $4.00 and pay Allbirds through Shopify's agent card checkout; card issuing isn't wired yet, so Allbirds did not receive this order.",
  }));

  app.get("/free", (_req, res) => {
    res.type("text/plain").send("hello, free world");
  });
  app.get("/big", (_req, res) => {
    res.type("text/plain").send("x".repeat(30_000));
  });
  app.get("/test-target/:name", (req, res) => {
    if (req.params.name === "orders" || req.params.name === "inventory") res.status(500).json({ error: "boom" });
    else res.json({ ok: true, name: req.params.name });
  });

  const bountyId = "api-reliability-check";
  const endpoints = () => ["users", "orders", "products", "inventory", "health"].map((n) => `${stub.url}/test-target/${n}`);
  app.get("/.well-known/agent-work", (req, res) => {
    res.setHeader("Vary", "Accept");
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.type("html").send("<h1>board</h1>");
      return;
    }
    const doc: AgentWorkDoc = {
      protocol: "agent-work",
      version: "0.1",
      site: { name: "Acme APIs", url: stub.url },
      bounties: [
        {
          id: bountyId,
          title: "API reliability check",
          description: "Call each endpoint in input.endpoints once and report which ones fail.",
          taskType: "api_reliability_check",
          input: { endpoints: endpoints() },
          payout: { amount: "0.50", asset: "USDC", network: NETWORK },
          slots: { total: 3, remaining: stub.slotsRemaining },
          claimTtlSeconds: 600,
          claimUrl: `${stub.url}/agent-work/bounties/${bountyId}/claim`,
          submitUrl: `${stub.url}/agent-work/bounties/${bountyId}/submit`,
          verification: "Your list of failing endpoints is compared to the known answer.",
          status: stub.slotsRemaining > 0 ? "open" : "full",
        },
      ],
    };
    res.json(doc);
  });

  app.post("/agent-work/bounties/:id/claim", (req, res) => {
    if (req.params.id !== bountyId) {
      res.status(404).json({ error: "bounty_not_found", message: "no such bounty" });
      return;
    }
    const walletAddress = (req.body as { walletAddress?: string }).walletAddress;
    if (!walletAddress) {
      res.status(400).json({ error: "invalid_request", message: "walletAddress required" });
      return;
    }
    if ([...stub.claims.values()].some((c) => c.walletAddress === walletAddress)) {
      res.status(409).json({ error: "already_claimed", message: "one slot per wallet" });
      return;
    }
    if (stub.slotsRemaining <= 0) {
      res.status(409).json({ error: "bounty_full", message: "no slots" });
      return;
    }
    stub.slotsRemaining--;
    const claimId = nid("clm");
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    stub.claims.set(claimId, { bountyId, walletAddress, expiresAt });
    const out: ClaimResponse = { claimId, bountyId, walletAddress: walletAddress as `0x${string}`, expiresAt, submitUrl: `${stub.url}/agent-work/bounties/${bountyId}/submit`, input: { endpoints: endpoints() } };
    res.status(201).json(out);
  });

  app.post("/agent-work/bounties/:id/submit", (req, res) => {
    const body = req.body as { claimId: string; walletAddress: string; result: { failing?: string[] } };
    stub.submits.push(body);
    const claim = stub.claims.get(body.claimId);
    if (!claim || claim.walletAddress !== body.walletAddress) {
      res.status(404).json({ error: "claim_not_found", message: "unknown claim" });
      return;
    }
    if (claim.expiresAt < new Date().toISOString()) {
      res.status(410).json({ error: "claim_expired", message: "too late" });
      return;
    }
    if (claim.paid) {
      res.json(claim.paid);
      return;
    }
    const expected = new Set([`${stub.url}/test-target/orders`, `${stub.url}/test-target/inventory`]);
    const got = new Set(body.result?.failing ?? []);
    const ok = got.size === expected.size && [...expected].every((e) => got.has(e));
    if (!ok) {
      res.status(422).json({ error: "rejected", message: "failing list does not match", details: { expectedCount: expected.size, gotCount: got.size } });
      return;
    }
    const txHash = `0x${"b".repeat(64)}` as const;
    const payout: PayoutResponse = { status: "paid", claimId: body.claimId, bountyId, amount: "0.50", asset: "USDC", network: NETWORK, to: body.walletAddress as `0x${string}`, txHash, explorerUrl: `http://explorer.test/tx/${txHash}`, paidAt: new Date().toISOString() };
    claim.paid = payout;
    res.setHeader("PAYOUT-RESPONSE", Buffer.from(JSON.stringify(payout)).toString("base64"));
    res.json(payout);
  });

  const { server, url } = await listen(app);
  stub.url = url;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
