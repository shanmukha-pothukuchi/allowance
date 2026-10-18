/**
 * Pure helpers for connected services (§13): catalog merge, search, labels.
 * No React, no fetch. Unit-tested in services.test.ts.
 */
import { isCustomGrant, isServiceApproval, isShopifyGrant, money, toCents } from "./format";
import type { AgentPublic, Approval, ConnectedService, DirectoryService, ServiceCategory } from "./types";

export { isCustomGrant, isServiceApproval, isShopifyGrant, serviceIdOfEvent, serviceOfEvent } from "./format";

export type CategoryFilter = "all" | ServiceCategory;

export const CATEGORIES: { id: CategoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "data", label: "Data" },
  { id: "shopping", label: "Shopping" },
  { id: "work", label: "Work" },
  { id: "tools", label: "Tools" },
];

/** The directory itself: every agent always has it; it is never "connected". */
export const DIRECTORY_ID = "directory";

export interface Connection {
  agent: AgentPublic;
  service: ConnectedService;
}

/** One card in the Services gallery: a directory entry, or a custom service an agent proposed. */
export interface CatalogEntry {
  service: DirectoryService;
  /** Agents that currently have it connected (directory: from their `services`, live). */
  connections: Connection[];
  /**
   * true for `source:"agent"` services the agent described itself; they only exist on agents, never
   * in the directory. A Shopify store an agent asked for is not custom (§15.3).
   */
  custom: boolean;
  /** Custom services: who proposed it (the agents that hold it). Pending proposals: who asked. */
  proposedBy: AgentPublic[];
  /** The always-on directory service. */
  builtIn: boolean;
  /** A pending request for something not in the directory yet (a proposed custom service or Shopify store). */
  proposal?: boolean;
}

type Searchable = Pick<DirectoryService, "name" | "summary" | "provider" | "category"> & { description?: string };

/** Case-insensitive match on name, summary, description, provider and category (same fields as §13.1). */
export function matchService(s: Searchable, q: string | undefined): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [s.name, s.summary, s.description ?? "", s.provider, s.category].join(" \n").toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

export function filterCatalog(entries: CatalogEntry[], q: string, category: CategoryFilter): CatalogEntry[] {
  return entries.filter((e) => (category === "all" || e.service.category === category) && matchService(e.service, q));
}

/** Turn a connected service the catalog does not list into a gallery entry shape. */
function customAsDirectory(c: ConnectedService): DirectoryService {
  return {
    id: c.id,
    name: c.name,
    provider: c.provider,
    icon: c.icon,
    color: c.color,
    category: c.category ?? (isShopifyGrant(c) ? "shopping" : "tools"),
    kind: c.kind,
    summary: c.summary,
    description: c.summary,
    baseUrl: c.baseUrl,
    pricing: c.pricing,
    maxPrice: c.maxPrice,
    permissions: c.permissions,
    source: c.source ?? "directory",
    docs: c.docs,
    ...(c.shopify ? { shopify: c.shopify } : {}),
  };
}

/**
 * Directory entries (in directory order) followed by connected services the directory does not
 * list: agent-proposed custom services (`source:"agent"`, they never come from the directory), and
 * any connection whose directory entry is missing (directory down, or entry removed) so the owner
 * can still see and disconnect it. Connections are always derived from the agents, so the gallery
 * is live even though the directory is fetched once.
 */
export function buildCatalog(directory: DirectoryService[], agents: AgentPublic[]): CatalogEntry[] {
  const connectionsOf = (id: string): Connection[] =>
    agents.flatMap((agent) => (agent.services ?? []).filter((s) => s.id === id).map((service) => ({ agent, service })));
  const out: CatalogEntry[] = directory.map((service) => ({
    service,
    connections: service.id === DIRECTORY_ID ? [] : connectionsOf(service.id),
    custom: isCustomGrant(service),
    proposedBy: [],
    builtIn: service.id === DIRECTORY_ID || service.kind === "directory",
  }));
  const known = new Set(directory.map((s) => s.id));
  const custom = new Map<string, CatalogEntry>();
  for (const agent of agents) {
    for (const s of agent.services ?? []) {
      if (known.has(s.id)) continue;
      const isCustom = isCustomGrant(s);
      const builtIn = s.id === DIRECTORY_ID || s.kind === "directory";
      const entry = custom.get(s.id) ?? { service: customAsDirectory(s), connections: [], custom: isCustom, proposedBy: [], builtIn };
      if (!entry.service.docs && s.docs) entry.service = { ...entry.service, docs: s.docs };
      if (!builtIn) entry.connections.push({ agent, service: s });
      if (isCustom) entry.proposedBy.push(agent);
      custom.set(s.id, entry);
    }
  }
  return [...out, ...custom.values()];
}

/** How a connection was made, in owner words. */
export function connectedByLabel(by: ConnectedService["connectedBy"] | undefined): string {
  switch (by) {
    case "approval":
      return "by approval";
    case "owner":
      return "by you";
    case "default":
      return "default";
    default:
      return "connected";
  }
}

/** "Free" for free services, else "Up to $18.50 per payment". */
export function priceCapLabel(maxPrice: string | undefined): string {
  return toCents(maxPrice) <= 0 ? "Free: cannot spend through it" : `Up to ${money(maxPrice)} per payment`;
}

export function sortConnections(cs: Connection[]): Connection[] {
  return [...cs].sort((a, b) => a.agent.name.localeCompare(b.agent.name));
}

/** Pending service approvals for one service id. */
export function requestsFor(approvals: Approval[], serviceId: string): Approval[] {
  return approvals.filter((a) => a.status === "pending" && isServiceApproval(a) && a.service?.id === serviceId);
}

/**
 * Add pending proposals (not yet on any agent) to the gallery so the owner can review them there
 * too: custom services and Shopify stores an agent asked to add. Directory requests already have a
 * card; this only adds what has none.
 */
export function withProposals(entries: CatalogEntry[], approvals: Approval[], agents: AgentPublic[]): CatalogEntry[] {
  const known = new Set(entries.map((e) => e.service.id));
  const extra = new Map<string, CatalogEntry>();
  for (const a of approvals) {
    const g = a.service;
    if (a.status !== "pending" || !isServiceApproval(a) || !g || known.has(g.id) || g.source !== "agent") continue;
    const proposer = agents.find((x) => x.id === a.agentId);
    const entry = extra.get(g.id) ?? {
      service: customAsDirectory({ ...g, connectedAt: a.createdAt, connectedBy: "approval" }),
      connections: [],
      custom: isCustomGrant(g),
      proposedBy: [],
      builtIn: false,
      proposal: true,
    };
    if (proposer && !entry.proposedBy.some((p) => p.id === proposer.id)) entry.proposedBy.push(proposer);
    extra.set(g.id, entry);
  }
  return [...entries, ...extra.values()];
}

// ---------------------------------------------------------------------------- Add service (§18)

/**
 * The one input of "Add service" takes a search or a link. It is a link when it has no spaces and
 * looks like an address: a scheme, `localhost`, or a dotted host ("allbirds.com", "x.myshopify.com/products/a").
 */
export function looksLikeLink(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  return /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(s);
}

/** The wallet's §18 answers for a link, in owner words. Its own message wins when it has one. */
export function serviceLinkError(err: { status?: number; code?: string; message?: string } | undefined): string {
  const code = err?.code;
  const message = (err?.message ?? "").trim();
  if (code === "unrecognized_service_url") {
    return message && message !== code ? message : "That link isn't something Allowance can pay: it's not in the directory, not a Shopify store, and it doesn't ask for payment over x402.";
  }
  if (code === "invalid_store_url" || (!code && err?.status === 400)) return message && message !== code ? message : "That doesn't look like a link.";
  if (code === "store_unsupported") return message || "Agents can't shop at this store.";
  if (code === "directory_unavailable") return message && message !== code ? message : "The service directory isn't answering. Try again in a moment.";
  if (err?.status === 502 || err?.status === 503 || err?.status === 504) return "The wallet couldn't reach that link. Try again in a moment.";
  return message || "Something went wrong. Try again.";
}

/** An x402 API's cap: at least what it asks for (the challenge amount), at most $1,000. */
export function checkApiCap(raw: string, asks: string | undefined): { ok: true; amount: string } | { ok: false; message: string } {
  const s = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, message: "A dollar amount, like 0.10." };
  const cents = toCents(s);
  if (cents < toCents(asks)) return { ok: false, message: `At least ${money(asks)}, what it asks for.` };
  if (cents > 100_000) return { ok: false, message: "At most $1,000.00." };
  return { ok: true, amount: (cents / 100).toFixed(2) };
}
