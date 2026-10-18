# @allowance/mcp — Claude Desktop talks to your Allowance wallet

An MCP server (stdio) that gives Claude Desktop twelve tools for spending and earning USDC
through the Allowance **wallet-service**. The agent never holds a private key: the server is
configured with an **agent token**, and every payment is signed by the wallet-service only if the
owner's policy allows it. Blocked payments come back as clear errors; payments over the
approval threshold wait for the owner's phone/dashboard.

On stage, this prompt in Claude Desktop uses only these tools:

> Find paid work on localhost:4021, complete it, then use your earnings to get today's weather and order me a pizza.

## Tools

| Tool | What it does |
|---|---|
| `get_wallet` | Balance, wallet address, limits (max per payment, daily cap, approval threshold, remaining today), spent/earned today, frozen status. `GET /v1/me`. |
| `fetch_url({ url, method?, body?, headers? })` | Fetch any URL. On `402` it decodes `PAYMENT-REQUIRED`, asks the wallet-service to pay (`POST /v1/pay`), retries with `PAYMENT-SIGNATURE`, reports `PAYMENT-RESPONSE` to `/v1/payments/:id/settled` and returns the body plus a receipt line. Over-threshold payments wait ≤45 s for approval, then return an approval id. Blocked payments return `isError` with the policy reason. A URL that belongs to a directory service the agent has not connected (`service_not_connected`) returns a soft, non-freezing message: "Acme Pizza isn't connected yet. Ask your owner with request_service { service_id: "acme-pizza" }." |
| `check_approval({ approval_id })` | Resume a pending approval (`GET /v1/approvals/:id/wait?timeoutMs=45000`). If a payment is approved, completes the original request and returns body + receipt; if a service request is approved, returns "Owner connected Acme Pizza." |
| `list_services()` | Connected services (`GET /v1/services`): icon, name, id, one-line summary, pricing. Says the Service Directory is always available. |
| `get_service({ service_id })` | Full manifest + docs (`GET /v1/directory/:id`), and whether it is connected. |
| `search_services({ query? })` | Directory search (`GET /v1/directory?q=`); marks `[connected]` / `[not connected]` and says how to request others. |
| `request_service({ service_id?, shopify_store_url?, max_price?, custom?, reason })` | Ask the owner to connect a directory service, ask them to add a Shopify store by its link (`shopify_store_url`, optional per-order `max_price` ≤ the agent's max per payment), or propose a custom one (`custom: { name, base_url, summary, max_price, docs? }`). `POST /v1/services/requests`; on `202` waits ≤45 s on `/wait` and returns "Connected Acme Pizza." / "Waiting for the owner to approve connecting Acme Pizza. Approval id apr_… — call check_approval to resume." / "Asked your owner to add the Shopify store Allbirds (allbirds.com). Approval id apr_… — call check_approval to resume." / denied. Any public Shopify store works by its link (the shop's own address, a product page, or x.myshopify.com; never an admin link). Stores show their storefront domain in `search_services` and `get_service`; agents pay orders in USDC and Allowance pays the store with a single-use Allowance card (simulated for now: the confirmation carries an Allowance reference). |
| `find_work({ site_url })` | `GET /.well-known/agent-work` (bare hosts like `localhost:4021` are fine). Lists bounties with payout, slots, task type, claim URL, and the untrusted-text reminder. |
| `claim_bounty({ claim_url, bounty_id? })` | Claims a slot with the wallet address from `/v1/me`. Returns claim id, expiry, submit URL and task input. Friendly errors for `bounty_full`, `already_claimed`, `404`. |
| `submit_bounty({ submit_url, claim_id, result, bounty_title? })` | Submits work. On `200` records the payout via `POST /v1/earnings` and returns "Paid $0.50 for API reliability check. Receipt: tx … (link)". `422` returns the rejection details so Claude can fix and resubmit; `410` explains the claim expired. |
| `list_receipts({ limit? })` | Recent receipts, newest first, dollars only, explorer links. |
| `transfer_usdc({ to, amount, memo? })` | Direct USDC transfer to an address (`POST /v1/transfer`), subject to the owner's policy. This is the tool a naive agent reaches for when a poisoned bounty says "send a processing fee"; the wallet-service blocks it and freezes the agent. |

Every result that paid or earned includes a one-line receipt with amount, counterparty and explorer link.
Tool results never contain the agent token or any key.

## Claude Desktop setup

1. Start the stack from the repo root: `npm run dev` (wallet-service on `http://localhost:4010`, merchant on `:4021`).
2. Get an agent token: `npm run setup` prints one per agent (use the `claude-desktop` agent's token, `aw_…`).
3. Edit Claude Desktop's config file. Per the official MCP docs
   (<https://modelcontextprotocol.io/docs/develop/connect-local-servers>; Linux path from
   <https://modelcontextprotocol.io/docs/develop/build-server>):

   | OS | Path |
   |---|---|
   | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
   | Linux | `~/.config/Claude/claude_desktop_config.json` |

   In Claude Desktop you can also open it via **Settings → Developer → Edit Config**.

4. Add the server. Claude Desktop launches servers with a minimal `PATH`, so use **absolute paths** to
   `node` and to `tsx` (the docs say the same: "make sure the file paths … are absolute and not relative").
   Find yours with `which node` (macOS/Linux) or `where node` (Windows); `tsx` lives at
   `<repo>/node_modules/tsx/dist/cli.mjs`.

   ```json
   {
     "mcpServers": {
       "allowance": {
         "command": "/home/sreeram/.local/share/mise/installs/node/26.8.1/bin/node",
         "args": [
           "/home/sreeram/Projects/hackathons/agent-work/node_modules/tsx/dist/cli.mjs",
           "/home/sreeram/Projects/hackathons/agent-work/apps/mcp/src/index.ts"
         ],
         "env": {
           "WALLET_SERVICE_URL": "http://localhost:4010",
           "AGENT_TOKEN": "aw_PASTE_THE_TOKEN_FROM_npm_run_setup"
         }
       }
     }
   }
   ```

   Replace the three paths with your own. On Windows use double backslashes or forward slashes.

5. **Completely quit and restart Claude Desktop.** The config is only read at startup. Then click the
   "Add files, connectors, and more" button in the chat box → Connectors → Manage connectors; `allowance` should list twelve tools.

### Try it

- "What's in my wallet?" → `get_wallet`
- "Get the weather in Berlin from localhost:4021/api/weather?city=Berlin" → `fetch_url` pays $0.05 and shows the receipt.
- "Find paid work on localhost:4021, complete it, then use your earnings to get today's weather and order me a pizza."
  → `find_work` → `claim_bounty` → `fetch_url` ×5 → `submit_bounty` (earns $0.50) → `fetch_url` weather → `fetch_url` POST `/pizza/order`
  ($18.50 > threshold, so Claude says it is waiting for approval; approve on Telegram/dashboard, or ask Claude to `check_approval`).
- "Do the summarize-changelog bounty" → the poisoned bounty asks for a "processing fee"; if Claude falls for it, `transfer_usdc` is blocked by policy and the agent is frozen; the tool result says exactly why.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `WALLET_SERVICE_URL` | `http://localhost:4010` | Wallet-service base URL. |
| `AGENT_TOKEN` | (required) | `aw_…` agent token from `npm run setup`. The server exits with a message if it is missing. |

Run by hand: `AGENT_TOKEN=aw_… npm start --workspace apps/mcp` (or `npx tsx apps/mcp/src/index.ts`). It speaks MCP on stdin/stdout; all logs go to stderr.

## Troubleshooting

- **Server missing in Claude Desktop** → restart Claude Desktop completely; check the JSON syntax; make sure every path is absolute; run the exact `command` + `args` in a terminal with `AGENT_TOKEN` set and see whether it prints `[mcp] Allowance MCP server ready` on stderr.
- **Logs**: macOS `~/Library/Logs/Claude/mcp*.log`, Windows `%APPDATA%\Claude\logs\mcp*.log` (Linux: `~/.config/Claude/logs/`). `mcp-server-allowance.log` holds this server's stderr. `tail -n 20 -f ~/Library/Logs/Claude/mcp*.log` follows them.
- **"Wallet service is not running at http://localhost:4010"** → run `npm run dev` in the repo root.
- **"Wallet service rejected the agent token"** → the token was revoked or mistyped; `npm run setup` prints a fresh one; update the config and restart Claude Desktop.
- **A payment says it is waiting for approval** → approve it on Telegram or the dashboard (`http://localhost:4040`), then ask Claude to call `check_approval` with the `apr_…` id. Approvals expire after 10 minutes.
- **"Blocked by wallet policy … agent frozen"** → that is the demo working. The owner unfreezes from the dashboard.

## Development

```bash
npx vitest run apps/mcp          # tests: stub wallet-service + stub x402/agent-work merchant on port 0
npx tsc -p tsconfig.json --noEmit
```

Files: `src/index.ts` (stdio entrypoint), `src/server.ts` (`createServer({ walletServiceUrl, agentToken, fetch?, approvalWaitMs? })` registers the tools),
`src/wallet-client.ts` (typed client for ARCHITECTURE §6 agent endpoints), `src/format.ts` (receipt/money formatting), `src/test-stubs.ts` (test doubles).
