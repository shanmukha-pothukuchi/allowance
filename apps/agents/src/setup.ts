/**
 * npm run setup
 *
 * Creates the demo agents with sensible policies, stores their tokens for the scripted agents in
 * DATA_DIR/agent-tokens.json, and prints the Claude Desktop MCP config snippet.
 *
 * Every agent gets a closed allowlist and its default connected services (docs §13.2): it can only
 * pay what is connected. If the wallet-service is running, agents are created through its HTTP API
 * and services connected with POST /v1/agents/:id/services. Otherwise they are written directly to
 * its state file via the offline store helper (the service picks them up on next start).
 * Re-running is safe: existing agents are kept (policy untouched), get a fresh token only if
 * missing, and get any missing default services.
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { loadConfig, DEFAULT_POLICY, ensureOwnerKey } from "@allowance/shared";
import type { CreateAgentRequest, CreateAgentResponse, AgentPublic } from "@allowance/shared";
import { readTokens, writeTokens, tokensPath, type TokenFile } from "./lib/tokens.js";
import { buildCatalog, buildSeeds, defaultServices, type Seed } from "./lib/seeds.js";

const config = loadConfig();
// Owner endpoints always need a key; generate one on first setup (services and the dashboard read it).
if (!config.ownerApiKey) config.ownerApiKey = ensureOwnerKey(config.dataDir);
const SEEDS: Seed[] = buildSeeds();
const CATALOG = buildCatalog({ merchantUrl: config.merchantUrl, directoryUrl: config.directoryUrl });

function ownerJsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.ownerApiKey) headers["x-owner-key"] = config.ownerApiKey;
  return headers;
}

/** Online path: connect each default service through the owner endpoint (idempotent). */
async function connectViaHttp(agent: AgentPublic, seed: Seed): Promise<string[]> {
  const have = new Set((agent.services ?? []).map((s) => s.id));
  const problems: string[] = [];
  for (const serviceId of seed.services) {
    if (have.has(serviceId)) continue;
    try {
      const r = await fetch(`${config.walletServiceUrl}/v1/agents/${agent.id}/services`, {
        method: "POST",
        headers: ownerJsonHeaders(),
        body: JSON.stringify({ serviceId }),
      });
      if (!r.ok) problems.push(`${serviceId} (${r.status} ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? ""})`);
    } catch (err) {
      problems.push(`${serviceId} (${(err as Error).message})`);
    }
  }
  return problems;
}

async function serviceUp(): Promise<boolean> {
  try {
    const r = await fetch(`${config.walletServiceUrl}/v1/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function createViaHttp(seed: Seed): Promise<CreateAgentResponse> {
  const body: CreateAgentRequest = { name: seed.name, policy: { ...DEFAULT_POLICY, ...seed.policy }, initialBalance: seed.initialBalance };
  const r = await fetch(`${config.walletServiceUrl}/v1/agents`, { method: "POST", headers: ownerJsonHeaders(), body: JSON.stringify(body) });
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

  const serviceProblems: string[] = [];
  const servicesLabel = (seed: Seed) => chalk.dim(seed.services.length ? `  [${seed.services.join(", ")}]` : "  [no services]");
  for (const seed of SEEDS) {
    const keep = existingNames.has(seed.name) && Boolean(tokens[seed.name]);
    if (!keep) {
      let res: CreateAgentResponse;
      if (up) {
        res = existingNames.has(seed.name) ? await reissueViaHttp(seed.name) : await createViaHttp(seed);
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
          services: defaultServices(CATALOG, seed.services),
        });
      }
      tokens[seed.name] = { agentId: res.agent.id, name: seed.name, address: res.agent.address, token: res.token };
    }

    // Default services, for new and kept agents alike (missing ones only).
    if (up) {
      const agent = (await listViaHttp()).find((a) => a.name === seed.name);
      if (agent) for (const p of await connectViaHttp(agent, seed)) serviceProblems.push(`${seed.name}: ${p}`);
    } else {
      const stored = store!.agentByName(seed.name);
      if (stored) {
        stored.services ??= [];
        const missing = seed.services.filter((id) => !stored.services.some((s) => s.id === id));
        if (missing.length) {
          stored.services.push(...defaultServices(CATALOG, missing));
          store!.save();
        }
      }
    }
    console.log(`  ${keep ? chalk.dim("keep  ") : chalk.green("create")} ${seed.name.padEnd(15)} ${chalk.dim(seed.note)}${servicesLabel(seed)}`);
  }
  writeTokens(config.dataDir, tokens);
  if (serviceProblems.length) {
    console.log(chalk.yellow(`  ! could not connect some default services (is the directory running at ${config.directoryUrl}?):`));
    for (const p of serviceProblems) console.log(chalk.yellow(`    ${p}`));
    console.log(chalk.yellow("    Connect them from the dashboard, or re-run npm run setup once the directory is up."));
  }

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
  console.log(chalk.bold("Chat with your agents: ") + config.agentChatUrl + chalk.dim("  (after npm run dev)"));
  if (!config.llm.apiKey && /nrp-nautilus\.io/.test(config.llm.baseUrl)) {
    console.log(chalk.yellow("  LLM_API_KEY is not set. Get an NRP token at https://nrp.ai/llmtoken/ and add LLM_API_KEY=... to .env"));
  }
  console.log(chalk.dim("Next: npm run dev. Scripted offline fallback (no model): npm run demo -- --auto-approve"));
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
