/**
 * The demo agents (docs/ARCHITECTURE.md §11 + §13.2). Every agent's allowlist is closed
 * (`{ addresses: [], origins: [] }`): it can only pay the services connected to it.
 */
import type { ConnectedService, Policy, ServiceManifest } from "@allowance/shared";
// Relative import on purpose: the @allowance/directory workspace link may not exist yet.
import { buildCatalog } from "../../../directory/src/catalog.js";

export interface Seed {
  name: string;
  policy: Partial<Policy>;
  initialBalance: string;
  note: string;
  /** Directory ids connected at setup (§13.2 table). */
  services: string[];
}

const CLOSED = (): NonNullable<Policy["allowlist"]> => ({ addresses: [], origins: [] });

export function buildSeeds(): Seed[] {
  return [
    {
      name: "claude-desktop",
      policy: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: CLOSED() },
      initialBalance: "20.00",
      note: "the agent inside Claude Desktop (MCP)",
      services: ["acme-bounties", "acme-weather"],
    },
    {
      name: "researcher",
      policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: CLOSED() },
      initialBalance: "20.00",
      note: "buys from paid APIs (act 2)",
      services: ["acme-weather", "acme-news", "acme-stocks"],
    },
    {
      name: "shopper",
      policy: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: CLOSED() },
      initialBalance: "20.00",
      note: "asks to connect Acme Pizza, then orders; needs approval (act 4)",
      services: [],
    },
    {
      name: "naive-worker",
      policy: { maxPerTx: "25.00", dailyCap: "50.00", approvalThreshold: "25.00", allowlist: CLOSED() },
      initialBalance: "20.00",
      note: "falls for the poisoned bounty (act 3)",
      services: ["acme-bounties"],
    },
    ...[1, 2, 3, 4].map((i) => ({
      name: `worker-${i}`,
      policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: CLOSED() },
      initialBalance: "20.00",
      note: "races for bounty slots (act 1)",
      services: ["acme-bounties"],
    })),
  ];
}

/** Connections for the offline path, built from the same catalog the directory serves. */
export function defaultServices(
  catalog: ServiceManifest[],
  ids: string[],
  connectedAt = new Date().toISOString(),
): ConnectedService[] {
  return ids.map((id) => {
    const m = catalog.find((s) => s.id === id);
    if (!m) throw new Error(`setup: no service "${id}" in the catalog`);
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      icon: m.icon,
      color: m.color,
      kind: m.kind,
      summary: m.summary,
      baseUrl: m.baseUrl,
      pricing: m.pricing,
      maxPrice: m.maxPrice,
      permissions: [...m.permissions],
      source: "directory",
      connectedAt,
      connectedBy: "default",
    };
  });
}

export { buildCatalog };
