#!/usr/bin/env -S npx tsx
/**
 * Allowance MCP server entrypoint (stdio). stdout is reserved for MCP protocol frames;
 * everything else goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, DEFAULT_BLOCKED_URLS } from "./server.js";

const walletServiceUrl = (process.env.WALLET_SERVICE_URL ?? "http://localhost:4010").replace(/\/+$/, "");
const agentToken = process.env.AGENT_TOKEN?.trim();

if (!agentToken) {
  console.error(
    "[mcp] AGENT_TOKEN is not set. Run `npm run setup` in the Allowance repo to print an agent token, then add it to the\n" +
      '[mcp] "env" of this server in claude_desktop_config.json: { "WALLET_SERVICE_URL": "http://localhost:4010", "AGENT_TOKEN": "aw_…" }',
  );
  process.exit(1);
}

const extraBlocked = (process.env.ALLOWANCE_BLOCKED_URLS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const server = createServer({ walletServiceUrl, agentToken, blockedUrls: [...DEFAULT_BLOCKED_URLS, ...extraBlocked] });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] Allowance MCP server ready (wallet-service ${walletServiceUrl}, token …${agentToken.slice(-4)})`);
