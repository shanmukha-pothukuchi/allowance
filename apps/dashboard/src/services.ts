/**
 * Pure helpers for connected services (§13): catalog merge, search, labels.
 * No React, no fetch. Unit-tested in services.test.ts.
 */
import { isServiceApproval, money, toCents } from "./format";
import type { AgentPublic, Approval, ConnectedService, DirectoryService, ServiceCategory } from "./types";

export { isCustomGrant, isServiceApproval, serviceIdOfEvent, serviceOfEvent } from "./format";

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
  /** true for `source:"agent"` services, which only exist on agents, never in the directory. */
  custom: boolean;
  /** Custom services: who proposed it (the agents that hold it). */
  proposedBy: AgentPublic[];
  /** The always-on directory service. */
  builtIn: boolean;
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
    category: "tools",
    kind: c.kind,
    summary: c.summary,
    description: c.summary,
    baseUrl: c.baseUrl,
    pricing: c.pricing,
    maxPrice: c.maxPrice,
    permissions: c.permissions,
    source: c.source ?? "directory",
    docs: c.docs,
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
    custom: service.source === "agent",
    proposedBy: [],
    builtIn: service.id === DIRECTORY_ID || service.kind === "directory",
  }));
  const known = new Set(directory.map((s) => s.id));
  const custom = new Map<string, CatalogEntry>();
  for (const agent of agents) {
    for (const s of agent.services ?? []) {
      if (known.has(s.id)) continue;
      const isCustom = s.source === "agent";
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
 * Add pending custom proposals (not yet on any agent) to the gallery so the owner can review them
 * there too. Directory requests already have a card; this only adds what has none.
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
      custom: true,
      proposedBy: [],
      builtIn: false,
    };
    if (proposer && !entry.proposedBy.some((p) => p.id === proposer.id)) entry.proposedBy.push(proposer);
    extra.set(g.id, entry);
  }
  return [...entries, ...extra.values()];
}
