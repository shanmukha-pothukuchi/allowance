import { describe, expect, it } from "vitest";
import { MOCK_DIRECTORY } from "./api/mockAdapter";
import { buildCatalog, CATEGORIES, checkApiCap, connectedByLabel, filterCatalog, looksLikeLink, matchService, priceCapLabel, requestsFor, serviceLinkError, withProposals } from "./services";
import type { AgentPublic, Approval, ConnectedService, DirectoryService } from "./types";

const directory: DirectoryService[] = MOCK_DIRECTORY.map(({ docs: _docs, ...m }) => (void _docs, m));
const conn = (id: string, by: ConnectedService["connectedBy"], extra: Partial<ConnectedService> = {}): ConnectedService => {
  const m = MOCK_DIRECTORY.find((x) => x.id === id);
  return {
    id,
    name: m?.name ?? id,
    provider: m?.provider ?? "example.com",
    icon: m?.icon ?? "🧩",
    color: m?.color ?? "#8E62D9",
    kind: "x402",
    summary: m?.summary ?? "custom",
    baseUrl: m?.baseUrl ?? "https://example.com/api",
    pricing: m?.pricing ?? "$0.25",
    maxPrice: m?.maxPrice ?? "0.25",
    permissions: m?.permissions ?? [],
    source: m ? "directory" : "agent",
    connectedAt: "2026-10-17T12:00:00Z",
    connectedBy: by,
    ...extra,
  };
};
const agent = (id: string, name: string, services: ConnectedService[]): AgentPublic => ({
  id,
  name,
  address: "0x1111111111111111111111111111111111111111",
  policy: { maxPerTx: "1.00", dailyCap: "5.00", allowlist: { addresses: [], origins: [] }, approvalThreshold: "1.00", frozen: false, freezeOnViolation: true },
  services,
  createdAt: "2026-10-17T00:00:00Z",
  balance: "20.00",
  spentToday: "0.00",
  earnedToday: "0.00",
  frozen: false,
});

const researcher = agent("agt_r", "researcher", [
  conn("acme-weather", "default"),
  conn("acme-news", "default"),
  conn("custom-hn", "approval", { name: "HN Digest", source: "agent", docs: "GET /top" }),
]);
const shopper = agent("agt_s", "shopper", [conn("acme-pizza", "owner")]);
const worker = agent("agt_w", "worker-1", [conn("acme-bounties", "default"), conn("directory", "default")]);
const agents = [researcher, shopper, worker];

describe("buildCatalog", () => {
  it("lists directory services in order, then agent-proposed custom services", () => {
    const cat = buildCatalog(directory, agents);
    expect(cat.map((e) => e.service.id)).toEqual(["directory", "acme-weather", "acme-news", "acme-stocks", "acme-pizza", "acme-bounties", "custom-hn"]);
    const custom = cat.at(-1)!;
    expect(custom.custom).toBe(true);
    expect(custom.proposedBy.map((a) => a.name)).toEqual(["researcher"]);
    expect(custom.service.docs).toBe("GET /top");
    expect(custom.service.source).toBe("agent");
  });

  it("derives connections from the agents, live, with how each was connected", () => {
    const cat = buildCatalog(directory, agents);
    const pizza = cat.find((e) => e.service.id === "acme-pizza")!;
    expect(pizza.connections.map((c) => [c.agent.name, c.service.connectedBy])).toEqual([["shopper", "owner"]]);
    expect(cat.find((e) => e.service.id === "acme-stocks")!.connections).toEqual([]);
    // the directory is built in: never listed as a connection even if an agent carries it
    const dir = cat.find((e) => e.service.id === "directory")!;
    expect(dir.builtIn).toBe(true);
    expect(dir.connections).toEqual([]);
  });

  it("does not duplicate a custom service held by two agents", () => {
    const other = agent("agt_x", "worker-2", [conn("custom-hn", "approval", { name: "HN Digest", source: "agent" })]);
    const cat = buildCatalog(directory, [...agents, other]);
    const custom = cat.filter((e) => e.service.id === "custom-hn");
    expect(custom).toHaveLength(1);
    expect(custom[0].connections.map((c) => c.agent.name)).toEqual(["researcher", "worker-2"]);
  });

  it("still shows connected services when the directory is down or no longer lists them", () => {
    const stray = agent("agt_z", "worker-3", [conn("acme-gone", "default", { source: "directory" })]);
    const cat = buildCatalog([], [stray, worker]);
    expect(cat.map((e) => e.service.id)).toEqual(["acme-gone", "acme-bounties", "directory"]);
    expect(cat[0].custom).toBe(false); // not flagged as agent-proposed
    expect(cat[0].connections.map((c) => c.agent.name)).toEqual(["worker-3"]);
    expect(cat[2].builtIn).toBe(true);
    expect(cat[2].connections).toEqual([]);
  });
});

describe("search and categories", () => {
  const cat = buildCatalog(directory, agents);
  it("matches name, summary, description, provider and category, case-insensitively", () => {
    expect(matchService(directory[4], "PIZZA")).toBe(true);
    expect(matchService(directory[4], "delivery")).toBe(true); // description
    expect(matchService(directory[1], "acme corp")).toBe(true); // provider
    expect(matchService(directory[1], "shopping")).toBe(false);
    expect(matchService(directory[1], "")).toBe(true);
    expect(matchService(directory[1], "weather forecast")).toBe(true); // every word
    expect(matchService(directory[1], "weather pizza")).toBe(false);
  });
  it("filters by chip and query together", () => {
    expect(filterCatalog(cat, "", "data").map((e) => e.service.id)).toEqual(["acme-weather", "acme-news", "acme-stocks"]);
    expect(filterCatalog(cat, "", "shopping").map((e) => e.service.id)).toEqual(["acme-pizza"]);
    expect(filterCatalog(cat, "", "work").map((e) => e.service.id)).toEqual(["acme-bounties"]);
    expect(filterCatalog(cat, "stock", "all").map((e) => e.service.id)).toEqual(["acme-stocks"]);
    expect(filterCatalog(cat, "stock", "shopping")).toEqual([]);
    expect(CATEGORIES.map((c) => c.label)).toEqual(["All", "Data", "Shopping", "Work", "Tools"]);
  });
});

describe("requests and proposals", () => {
  const grant = { id: "custom-new", name: "New Thing", provider: "new.example", icon: "🧩", color: "#000", kind: "x402" as const, summary: "s", baseUrl: "https://new.example", pricing: "$1", maxPrice: "1.00", permissions: [], source: "agent" as const };
  const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({
    id,
    kind: "service",
    agentId: "agt_r",
    agentName: "researcher",
    paymentId: "",
    amount: "1.00",
    description: "Connect New Thing",
    counterparty: { address: "0x2222222222222222222222222222222222222222" },
    service: grant,
    reason: "need it",
    status: "pending",
    createdAt: "2026-10-17T12:00:00Z",
    ...extra,
  });
  it("adds a card for a pending custom proposal, once, with who proposed it", () => {
    const cat = withProposals(buildCatalog(directory, agents), [approval("apr_1"), approval("apr_2")], agents);
    const card = cat.filter((e) => e.service.id === "custom-new");
    expect(card).toHaveLength(1);
    expect(card[0].custom).toBe(true);
    expect(card[0].connections).toEqual([]);
    expect(card[0].proposedBy.map((a) => a.name)).toEqual(["researcher"]);
  });
  it("adds nothing for decided requests or directory requests (those already have a card)", () => {
    const base = buildCatalog(directory, agents);
    expect(withProposals(base, [approval("apr_1", { status: "denied" })], agents)).toHaveLength(base.length);
    const pizzaReq = approval("apr_3", { service: { ...grant, id: "acme-pizza", source: "directory" } });
    expect(withProposals(base, [pizzaReq], agents)).toHaveLength(base.length);
    expect(requestsFor([pizzaReq, approval("apr_4", { status: "approved" })], "acme-pizza").map((a) => a.id)).toEqual(["apr_3"]);
  });
});

describe("Shopify stores (§15)", () => {
  const juniper = {
    id: "shopify-juniper-goods",
    name: "Juniper Goods",
    provider: "Shopify store",
    icon: "🛍️",
    color: "#95BF47",
    kind: "x402" as const,
    category: "shopping" as const,
    summary: "Shop Juniper Goods",
    baseUrl: "http://localhost:4070/shops/juniper-goods",
    pricing: "Store prices · paid with your Allowance card · up to $20.00 per order",
    maxPrice: "20.00",
    permissions: ["Browse Juniper Goods's catalog"],
    source: "agent" as const,
    shopify: { handle: "juniper-goods", domain: "juniper-goods.myshopify.com", storefrontUrl: "https://junipergoods.com", cardCheckout: false },
  };
  const request: Approval = {
    id: "apr_shop",
    kind: "service",
    agentId: "agt_s",
    agentName: "shopper",
    paymentId: "",
    amount: "0.00",
    description: "Add the Shopify store Juniper Goods",
    counterparty: { address: "0x2222222222222222222222222222222222222222" },
    service: juniper,
    reason: "candles",
    status: "pending",
    createdAt: "2026-10-17T12:00:00Z",
  };

  it("shows a store an agent asked for as a pending Shopify card, not as a custom service", () => {
    const cat = withProposals(buildCatalog(directory, agents), [request], agents);
    const card = cat.find((e) => e.service.id === "shopify-juniper-goods")!;
    expect(card).toMatchObject({ custom: false, proposal: true, connections: [] });
    expect(card.proposedBy.map((a) => a.name)).toEqual(["shopper"]);
    expect(card.service).toMatchObject({ category: "shopping", shopify: { domain: "juniper-goods.myshopify.com", storefrontUrl: "https://junipergoods.com" } });
    expect(filterCatalog(cat, "", "shopping").map((e) => e.service.id)).toEqual(["acme-pizza", "shopify-juniper-goods"]);
    expect(requestsFor([request], "shopify-juniper-goods")).toHaveLength(1);
  });

  it("keeps the store's shopify facts on a connection the directory does not list", () => {
    const holder = agent("agt_s2", "gift-scout", [conn("shopify-juniper-goods", "approval", { ...juniper, source: "directory" })]);
    const entry = buildCatalog(directory, [holder]).find((e) => e.service.id === "shopify-juniper-goods")!;
    expect(entry.custom).toBe(false);
    expect(entry.service.category).toBe("shopping");
    expect(entry.service.shopify).toEqual(juniper.shopify);
  });
});

describe("labels", () => {
  it("says how a service was connected", () => {
    expect(connectedByLabel("approval")).toBe("by approval");
    expect(connectedByLabel("owner")).toBe("by you");
    expect(connectedByLabel("default")).toBe("default");
  });
  it("states the price cap in dollars", () => {
    expect(priceCapLabel("18.5")).toBe("Up to $18.50 per payment");
    expect(priceCapLabel("0.00")).toMatch(/^Free/);
    expect(priceCapLabel(undefined)).toMatch(/^Free/);
  });
});

describe("Add service (§18)", () => {
  it("tells a link from a search", () => {
    for (const s of ["allbirds.com", "https://www.allbirds.com/products/x", "localhost:4321/api/weather", "x.myshopify.com", "http://127.0.0.1:4080/quantcomm"]) expect(looksLikeLink(s)).toBe(true);
    for (const s of ["weather", "acme news", "", "flood research", "pizza."]) expect(looksLikeLink(s)).toBe(false);
  });
  it("puts the wallet's link errors in plain words", () => {
    expect(serviceLinkError({ status: 422, code: "unrecognized_service_url", message: "unrecognized_service_url" })).toMatch(/^That link isn't something Allowance can pay/);
    expect(serviceLinkError({ status: 422, code: "store_unsupported", message: "This store only sells in EUR." })).toBe("This store only sells in EUR.");
    expect(serviceLinkError({ status: 503 })).toMatch(/couldn't reach/);
    expect(serviceLinkError({ status: 503, code: "directory_unavailable", message: "directory_unavailable" })).toMatch(/directory isn't answering/);
  });
  it("an API's cap is at least what it asks", () => {
    expect(checkApiCap("0.10", "0.05")).toEqual({ ok: true, amount: "0.10" });
    expect(checkApiCap("0.01", "0.05")).toEqual({ ok: false, message: "At least $0.05, what it asks for." });
    expect(checkApiCap("abc", "0.05").ok).toBe(false);
  });
});
