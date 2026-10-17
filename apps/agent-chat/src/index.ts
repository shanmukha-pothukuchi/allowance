/**
 * Agent chat server: http://localhost:4050
 *
 * Hosts the wallet-holding agents as chat agents. They are idle until you message them. Each one
 * talks to an OpenAI-compatible LLM (default: NRP's managed models) and acts only through the same
 * MCP tools Claude Desktop uses, so every payment goes through the wallet-service and its policy.
 */
import { resolve } from "node:path";
import { loadConfig } from "@allowance/shared";
import { DEFAULT_BLOCKED_URLS } from "@allowance/mcp/server";
import { createChatApp } from "./app.js";
import { loadRoster } from "./roster.js";

export { createChatApp, lastMessageOf, type AgentSummary, type ServiceChip, type LastMessage } from "./app.js";
export { ChatAgent, systemPrompt, servicesBlock } from "./agent.js";
export { chatCompletion, LlmError } from "./llm.js";
export { loadRoster, groupMembers } from "./roster.js";

const LOG = "[agent-chat]";
const isMain = process.argv[1] && /agent-chat[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  // This is an agent-side process. It must never hold owner powers.
  config.ownerApiKey = undefined;

  const roster = loadRoster(config.dataDir);
  if (roster.length === 0) console.warn(`${LOG} no agents found in ${config.dataDir}/agent-tokens.json. Run npm run setup.`);
  if (!config.llm.apiKey && /nrp-nautilus\.io/.test(config.llm.baseUrl)) {
    console.warn(`${LOG} LLM_API_KEY is not set. Get an NRP token at https://nrp.ai/llmtoken/ and add LLM_API_KEY=... to .env`);
  }

  const chat = createChatApp({
    walletServiceUrl: config.walletServiceUrl,
    llm: { ...config.llm },
    roster,
    dataDir: resolve(config.dataDir, "agent-chat"),
    blockedUrls: [...DEFAULT_BLOCKED_URLS, config.agentChatUrl, `http://localhost:${config.dashboardPort}`],
    links: {
      dashboard: `http://localhost:${config.dashboardPort}`,
      board: `${config.merchantUrl}/.well-known/agent-work`,
      explorer: config.chainMode === "mock" ? `${config.facilitatorUrl}/explorer` : undefined,
    },
  });
  const server = chat.app.listen(config.agentChatPort, config.agentChatHost, () => {
    console.log(`${LOG} chat with your agents at http://localhost:${config.agentChatPort} (model ${config.llm.model} @ ${config.llm.baseUrl}, ${roster.length} agents)`);
  });
  void chat.ready;
  const shutdown = () => {
    void chat.close().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
