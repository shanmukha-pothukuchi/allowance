import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentSpec {
  name: string;
  role: string;
  token: string;
}

/** Who each agent is. Unknown names get the generic role. */
export const ROLES: Record<string, string> = {
  researcher: "You are a research assistant. You find information for your owner and buy data from paid APIs when it helps.",
  shopper: "You are a shopping assistant. You buy things your owner asks for from sites that accept your wallet.",
};
const WORKER_ROLE = "You are a freelance worker. You earn USDC by finding paid tasks on websites (the agent-work protocol), doing them carefully, and submitting the results.";
const GENERIC_ROLE = "You are a general-purpose assistant with a wallet.";

export function roleFor(name: string): string {
  if (ROLES[name]) return ROLES[name];
  if (/^worker-\d+$/.test(name)) return WORKER_ROLE;
  return GENERIC_ROLE;
}

/**
 * Agents served by the chat server. claude-desktop is reserved for Claude Desktop (MCP), and
 * naive-worker is the scripted stand-in used only by the offline `npm run demo` fallback.
 */
export const EXCLUDED = new Set(["claude-desktop", "naive-worker"]);
const ORDER = ["researcher", "shopper"];

/** Groups the presenter can message at once (e.g. the bounty race). */
export function groupMembers(group: string, names: string[]): string[] {
  if (group === "workers") return names.filter((n) => /^worker-\d+$/.test(n));
  if (group === "all") return names;
  return [];
}

export function loadRoster(dataDir: string): AgentSpec[] {
  const file = resolve(dataDir, "agent-tokens.json");
  if (!existsSync(file)) return [];
  const tokens = JSON.parse(readFileSync(file, "utf8")) as Record<string, { name: string; token: string; role?: string }>;
  return Object.values(tokens)
    .filter((t) => t?.token && !EXCLUDED.has(t.name))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, role: t.role || roleFor(t.name), token: t.token }));
}

function rank(n: string): number {
  const i = ORDER.indexOf(n);
  return i === -1 ? ORDER.length : i;
}
