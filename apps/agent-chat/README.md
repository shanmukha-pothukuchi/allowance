# @allowance/agent-chat

Chat agents with Allowance wallets, at http://localhost:4050 (started by `npm run dev`).

Each agent in `.data/agent-tokens.json` (from `npm run setup`) becomes a chat agent. Agents are idle
until you message them. They talk to any OpenAI-compatible model (NRP's managed LLMs by default) and
act only through the same MCP tools Claude Desktop uses, so every payment goes through the
wallet-service and the owner's policy. The chat server holds agent tokens, never keys or the owner key.

## Configure

In the repo's `.env`:

```bash
LLM_BASE_URL=https://ellm.nrp-nautilus.io/v1   # any OpenAI-compatible endpoint
LLM_API_KEY=...                                 # NRP token: https://nrp.ai/llmtoken/
LLM_MODEL=qwen3                                 # also: gpt-oss, gemma, minimax-m2
# LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}   # faster replies on qwen3
```

## Use

- Pick an agent and type, or click a suggested prompt.
- **All workers** sends one message to every worker at once. They race for the same bounty slots.
- Tool calls appear as cards: green when they succeeded, red when the wallet or site refused.
  Click one to see the full arguments and output.
- When a payment needs approval, the agent shows "waiting for your approval". Approve on Telegram
  or the dashboard; the agent continues by itself.
- **Stop** aborts a run. **Clear** forgets the conversation.

API and internals: `docs/ARCHITECTURE.md` §9b. Tests: `npx vitest run apps/agent-chat`.
