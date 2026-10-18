# Allowance

**A safe wallet for your AI agent, in the apps you already use.**

Give an agent money without giving it your keys. Let any website pay it for work. Watch it all from
your phone.

## The three things that are new here

1. **`agent-work`: an open protocol for getting paid.** x402 gave agents a standard way to *pay*
   for things. Nothing comparable existed for a website to pay an agent. Any site publishes paid tasks
   at `/.well-known/agent-work`; an agent discovers them, claims a slot, does the work, submits, and
   receives USDC with a transaction hash. No marketplace, no platform in the middle: it is one line
   of Express middleware and a one-page spec. → [`docs/agent-work-spec.md`](docs/agent-work-spec.md),
   [`packages/agent-work`](packages/agent-work)
2. **Money rules enforced outside the agent.** The agent never holds a private key. A wallet
   service holds one key per agent and signs only what the owner's policy allows: max per payment,
   daily cap, allowlist, approval threshold, freeze. Tell an agent to send its whole balance to an
   attacker, or plant that instruction in a bounty. The agent may try. The wallet refuses, freezes
   the agent, and the owner's phone buzzes. Whatever the model was told, the wallet holds.
3. **It works in the apps people already use.** Agents are real LLM agents you chat with, either in
   Claude Desktop through our MCP server or on the agent chat page. They do nothing until you ask.
   The owner approves purchases and gets alerts in Telegram. The dashboard is for the big screen.

Everything else (x402 paywalls, a pizza endpoint, a USDC ledger) is supporting cast built on the
official `@x402/*` packages.

## How it fits together

```
 you ──chat──▶ agent chat :4050 ──┐                      ┌──▶ merchant :4021  (x402 APIs, pizza,
 you ──chat──▶ Claude Desktop ────┤  MCP tools            │                    agent-work bounties)
                                  │  (token, no key) ─────┤
                                  └──▶ wallet-service :4010 ──▶ facilitator :4030 (mock ledger)
                                         │ policy, keys, approvals, receipts,
                                         │ connected services ◀── directory :4060 (catalog)
                                         └─events─▶ dashboard :4040, Telegram bot (owner)
```

Agents can only pay **connected services**. A directory lists every service that exists; each agent
sees its connected services in its context (like skill descriptions) and loads a service's docs on
demand. When it needs something it doesn't have, it searches the directory and asks you to connect
it, or proposes a new one; you approve on your phone, the dashboard, or inline in the chat. Paying an
unconnected service gets a polite "ask your owner"; paying an unknown address is blocked and freezes
the agent.

Agents are idle until you message them. Each chat agent is an LLM tool-use loop (any
OpenAI-compatible endpoint; NRP's managed models by default) over the same MCP tools Claude Desktop
gets, so every payment goes through the wallet-service and its policy. Nothing generates activity on
its own: every event on the dashboard is a real wallet action.

## Quickstart

```bash
npm install
npm test
cp .env.example .env   # add LLM_API_KEY (NRP token from https://nrp.ai/llmtoken/)
npm run setup          # creates agents + tokens + owner key, prints the Claude Desktop snippet
npm run dev            # facilitator, wallet-service, merchant, notifier, dashboard, agent chat
```

| Screen | URL |
|---|---|
| Chat with your agents (iMessage-style; sidebar collapses to icons) | http://localhost:4050 |
| Service directory | http://localhost:4060 |
| Owner dashboard | http://localhost:4040 |
| Bounty board (the `agent-work` document, as HTML) | http://localhost:4021/.well-known/agent-work |
| Mock explorer | http://localhost:4030/explorer |

On the chat page, pick **All workers** and send *"Find paid work on localhost:4021 and complete the
API reliability check bounty."* Four agents race for three slots at the same moment. Then ask the
researcher for the weather. Ask the shopper for a pizza: it has no pizza service, so it finds Acme
Pizza in the directory and asks you to connect it, then asks you to approve the $18.50 payment. Both
approvals appear inline in the chat, on the dashboard and on Telegram. Finally, tell any agent to send
its balance to `0x000000000000000000000000000000000000dEaD`.

**Build your own team.** From the chat's **New** menu (or the dashboard's **New agent** button):
create an agent with a name, a purpose, starting money, spending limits and services; it opens in
the wallet's own form, because creating an agent and adding money are owner powers. **Add money**
tops up any agent. **New broadcast** makes a group of agents you message at once, like a WhatsApp
broadcast list; each agent replies on its own and pays only within its own policy.

**Shop at any Shopify store.** Paste any store or product link in the dashboard (Services › Add a
Shopify store), or just tell an agent "buy me wool runners from allbirds.com": it finds the store,
asks you to add it, searches the real catalog, builds a real Shopify cart and pays the total in USDC
from its wallet, within its limits and your approvals. That USDC funds a single-use **Allowance
Card**, which would pay the store through Shopify's agent card checkout. Issuing the card and that
last call are simulated here, so the order confirmation is labelled "Simulated order". Nothing uses
or shows a store's admin, and no store credentials are needed. Stores whose catalog isn't public
(e.g. password-protected dev stores) are reported as unsupported.

`npm run reset` wipes `.data/` (keys, tokens, ledger, receipts, conversations) and re-runs setup.
Stop `npm run dev` first; reset refuses to run under live services.

### LLM settings

| Variable | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `https://ellm.nrp-nautilus.io/v1` | Any OpenAI-compatible chat-completions endpoint |
| `LLM_API_KEY` | none | NRP token from https://nrp.ai/llmtoken/ |
| `LLM_MODEL` | `qwen3` | NRP models with tool calling include `qwen3`, `gpt-oss`, `gemma`, `minimax-m2` |
| `LLM_EXTRA_BODY` | none | JSON merged into each request, e.g. `{"chat_template_kwargs":{"enable_thinking":false}}` for faster replies |

NRP allows 16 concurrent requests per user on `qwen3` and `gpt-oss`, enough for the four-worker race.
The client retries 429s and 5xx with backoff, and the chat page shows "model busy, retrying".

### Offline fallback (no model)

`npm run demo -- --auto-approve` is a **scripted** run of the same four scenarios against the real
services, for when there is no network or no key. No model is involved and it says so on screen.
The real agents are the chat agents and Claude Desktop.

## Claude Desktop

1. `npm run setup` prints a JSON snippet. Paste it into Claude Desktop's `claude_desktop_config.json`
   (see [`apps/mcp/README.md`](apps/mcp/README.md) for the file location and troubleshooting).
2. Restart Claude Desktop. Keep `npm run dev` running.
3. Try: *"Find paid work on localhost:4021, complete it, then use your earnings to get today's
   weather and order me a pizza."*

The MCP server gets an agent **token**, never a key. Tools: `get_wallet`, `fetch_url` (pays 402s
through the wallet), `find_work`, `claim_bounty`, `submit_bounty`, `list_receipts`,
`check_approval`, `transfer_usdc`, and the service tools `list_services`, `get_service`,
`search_services`, `request_service`. `fetch_url` refuses the wallet's own control plane (wallet API,
dashboard, chat server, facilitator admin) and drops any credential headers the model supplies.

## Telegram (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. `cp .env.example .env`, set `TELEGRAM_BOT_TOKEN=...`.
3. `npm run dev`, then send `/start` to your bot. It pairs your chat as the owner.

You will get approval requests with Approve / Deny buttons, block alerts, and receipts. If the token
is missing or Telegram is unreachable, approvals appear on the dashboard instead and nothing breaks.

## Base Sepolia (real testnet USDC)

Coded on the same path as mock mode, but **not exercised in our tests** (no funded keys in CI).

1. Generate keys: `node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log(k, privateKeyToAccount(k).address)"`
   for the merchant (company) wallet. Agent keys are generated by the wallet-service.
2. Fund them: Base Sepolia ETH from a faucet (e.g. https://www.alchemy.com/faucets/base-sepolia or
   https://docs.base.org/base-chain/tools/network-faucets) and testnet USDC from
   https://faucet.circle.com (select Base Sepolia). USDC contract:
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
3. In `.env`: `CHAIN_MODE=base-sepolia`, `MERCHANT_PRIVATE_KEY=0x...`,
   `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`, `X402_FACILITATOR_URL=https://x402.org/facilitator`.
4. Agents pay with gasless EIP-3009 authorizations (the facilitator pays gas). Direct transfers and
   bounty payouts are plain USDC `transfer` calls and need a little ETH in the sending wallet.

Mainnet is never configured anywhere in this repo.

## Simulated vs real

| Thing | Status |
|---|---|
| x402 v2 protocol (headers, EIP-3009 signatures, facilitator interface) | Real: official `@x402/*` packages |
| EIP-712 signature verification in mock mode | Real (viem `verifyTypedData`) |
| Settlement in mock mode | Simulated: in-memory ledger, fake but well-formed tx hashes, local explorer |
| Settlement in `base-sepolia` mode | Real testnet USDC; coded, untested here |
| Policy engine, approvals, freeze, receipts, tokens | Real |
| Owner API auth | Real: an owner key (generated by setup) is required for approve, unfreeze, policy, top-up; the agent's `fetch_url` tool refuses the wallet's own API |
| Origin allowlist | Real, and verified: the wallet re-fetches the 402 and signs only what the site actually demands |
| Checks on agent-reported settlements and bounty payouts | Real in mock mode (looked up on the ledger); skipped in `base-sepolia` mode |
| Telegram approvals and alerts | Real (grammy, long polling) |
| Pizza fulfillment, "virtual card" | **Simulated**. No card, no offramp, no pizza. |
| "Add $20 with card" on the dashboard | Simulated top-up (mints on the mock ledger) |
| The poisoned bounty's attacker | A burn-style address; nothing is ever sent |
| Shopify catalogs, prices and carts | Real (public Storefront API, any store) |
| Paying a Shopify store with the Allowance Card | **Simulated** (the agent's USDC payment is real; card issuing and Shopify's agent card checkout are not wired) |
| Chat agents | Real LLM agents (OpenAI-compatible endpoint); they act only when you message them |
| `npm run demo` | Scripted fallback; no model, labelled as such |

## Repo layout

```
packages/shared/        types, config, event + receipt schema, money helpers
packages/wallet/        policy engine + EIP-3009 signer + settlement adapters (pure, tested)
packages/agent-work/    the protocol: Express middleware, HTML board, client
apps/wallet-service/    agent keys, tokens, policy, approvals, receipts, SSE
apps/notifier/          Telegram bot
apps/merchant/          3 x402 APIs, pizza, test-target API, two bounties
apps/mock-facilitator/  in-memory USDC ledger + x402 facilitator API + explorer
apps/mcp/               MCP server for Claude Desktop
apps/dashboard/         Vite + React owner UI
apps/agent-chat/        chat agents (LLM tool loop over the MCP tools), chat page on :4050
apps/directory/         service directory (catalog of services agents can connect) on :4060
apps/shopify-bridge/    any public Shopify store as an x402 service: catalog, real carts, USDC → Allowance Card, on :4070
apps/agents/            setup, reset, scripted offline demo
docs/                   ARCHITECTURE.md, agent-work-spec.md, DEMO.md
```

Architecture and every inter-service contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Stage script: [`docs/DEMO.md`](docs/DEMO.md).
