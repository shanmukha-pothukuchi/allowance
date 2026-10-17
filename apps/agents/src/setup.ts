/**
 * npm run setup
 *
 * Creates the demo agents with sensible policies, stores their tokens for the scripted agents in
 * DATA_DIR/agent-tokens.json, and prints the Claude Desktop MCP config snippet.
 *
 * If the wallet-service is running, agents are created through its HTTP API. Otherwise they are
 * written directly to its state file via the offline store helper (the service picks them up on
 * next start). Re-running is safe: existing agents are kept and get a fresh token only if missing.
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { loadConfig, DEFAULT_POLICY } from "@allowance/shared";
import type { CreateAgentRequest, CreateAgentResponse, Policy, AgentPublic } from "@allowance/shared";
import { readTokens, writeTokens, tokensPath, type TokenFile } from "./lib/tokens.js";

const config = loadConfig();
const merchantOrigin = config.merchantUrl;

interface Seed {
  name: string;
  policy: Partial<Policy>;
  initialBalance: string;
  note: string;
}

const SEEDS: Seed[] = [
  {
    name: "claude-desktop",
    policy: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: { addresses: [], origins: [merchantOrigin] } },
    initialBalance: "20.00",
    note: "the agent inside Claude Desktop (MCP)",
  },
  {
    name: "researcher",
    policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: null },
    initialBalance: "20.00",
    note: "buys from paid APIs (act 2)",
  },
  {
    name: "shopper",
    policy: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", allowlist: { addresses: [], origins: [merchantOrigin] } },
    initialBalance: "20.00",
    note: "orders the pizza; needs approval (act 4)",
  },
  {
    name: "naive-worker",
    policy: { maxPerTx: "25.00", dailyCap: "50.00", approvalThreshold: "25.00", allowlist: { addresses: [], origins: [merchantOrigin] } },
    initialBalance: "20.00",
    note: "falls for the poisoned bounty (act 3)",
  },
  ...[1, 2, 3, 4].map((i) => ({
    name: `worker-${i}`,
    policy: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00", allowlist: { addresses: [], origins: [merchantOrigin] } },
    initialBalance: "20.00",
    note: "races for bounty slots (act 1)",
  })),
];

async function serviceUp(): Promise<boolean> {
  try {
    const r = await fetch(`${config.walletServiceUrl}/v1/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function createViaHttp(seed: Seed): Promise<CreateAgentResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.ownerApiKey) headers["x-owner-key"] = config.ownerApiKey;
  const body: CreateAgentRequest = { name: seed.name, policy: { ...DEFAULT_POLICY, ...seed.policy }, initialBalance: seed.initialBalance };
  const r = await fetch(`${config.walletServiceUrl}/v1/agents`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST /v1/agents ${r.status}: ${await r.text()}`);
  return (await r.json()) as CreateAgentResponse;
}

async function listViaHttp(): Promise<AgentPublic[]> {
  const headers: Record<string, string> = {};
  if (config.ownerApiKey) headers["x-owner-key"] = config.ownerApiKey;
  const r = await fetch(`${config.walletServiceUrl}/v1/agents`, { headers });
  return ((await r.json()) as { agents: AgentPublic[] }).agents ?? [];
}

async function main() {
  console.log(chalk.bold(`Allowance setup  ·  ${config.chainMode} mode  ·  data in ${config.dataDir}`));
  const tokens: TokenFile = readTokens(config.dataDir);
  const up = await serviceUp();

  // Offline path: write straight into the wallet-service state file (service picks it up on start).
  const ws = up ? null : await import("@allowance/wallet-service");
  const store = ws ? ws.openStore(config.dataDir) : null;

  const existingNames = new Set<string>(
    up ? (await listViaHttp()).map((a) => a.name) : store!.state.agents.map((a) => a.name),
  );

  for (const seed of SEEDS) {
    if (existingNames.has(seed.name) && tokens[seed.name]) {
      console.log(`  ${chalk.dim("keep")}   ${seed.name.padEnd(15)} ${chalk.dim(seed.note)}`);
      continue;
    }
    let res: CreateAgentResponse;
    if (up) {
      res = existingNames.has(seed.name)
        ? await reissueViaHttp(seed.name)
        : await createViaHttp(seed);
    } else if (existingNames.has(seed.name)) {
      const stored = store!.agentByName(seed.name)!;
      const { token, stored: tok } = ws!.issueToken(store!, stored.id);
      store!.save();
      res = { agent: { id: stored.id, name: stored.name, address: stored.address } as AgentPublic, token, tokenId: tok.id };
    } else {
      res = ws!.createAgentOffline(store!, {
        name: seed.name,
        policy: { ...DEFAULT_POLICY, ...seed.policy },
        initialBalance: seed.initialBalance,
      });
    }
    tokens[seed.name] = { agentId: res.agent.id, name: seed.name, address: res.agent.address, token: res.token };
    console.log(`  ${chalk.green("create")} ${seed.name.padEnd(15)} ${chalk.dim(seed.note)}`);
  }
  writeTokens(config.dataDir, tokens);

  const cd = tokens["claude-desktop"];
  // Claude Desktop spawns servers with a minimal PATH, so use absolute paths to node and tsx.
  const tsxCli = resolve(config.repoRoot, "node_modules/tsx/dist/cli.mjs");
  const entry = resolve(config.repoRoot, "apps/mcp/src/index.ts");
  const snippet = {
    mcpServers: {
      allowance: {
        command: process.execPath,
        args: existsSync(tsxCli) ? [tsxCli, entry] : ["--import", "tsx", entry],
        env: { WALLET_SERVICE_URL: config.walletServiceUrl, AGENT_TOKEN: cd.token },
      },
    },
  };
  console.log("");
  console.log(chalk.bold("Tokens written to ") + tokensPath(config.dataDir) + chalk.dim("  (git-ignored; scripted agents read them)"));
  console.log("");
  console.log(chalk.bold("Claude Desktop → claude_desktop_config.json:"));
  console.log(JSON.stringify(snippet, null, 2));
  console.log("");
  console.log(chalk.dim("Next: npm run dev   then   npm run demo -- --auto-approve"));
}

async function reissueViaHttp(name: string): Promise<CreateAgentResponse> {
  const agents = await listViaHttp();
  const agent = agents.find((a) => a.name === name)!;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.ownerApiKey) headers["x-owner-key"] = config.ownerApiKey;
  const r = await fetch(`${config.walletServiceUrl}/v1/agents/${agent.id}/tokens`, { method: "POST", headers });
  const { token, tokenId } = (await r.json()) as { token: string; tokenId: string };
  return { agent, token, tokenId };
}

main().catch((e) => {
  console.error(chalk.red(`setup failed: ${e?.stack ?? e}`));
  process.exit(1);
});
