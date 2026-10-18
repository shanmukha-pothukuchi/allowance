# DEMO.md — the 3-minute stage run

Everything here is live: real LLM agents (NRP managed models, `qwen3` by default; each act takes about
30 seconds with it) that act only when you message them,
a real policy wallet, real x402 payments settled on the mock ledger. Nothing on screen is generated
on its own.


## Demo cast (one agent per feature)

After `npm run setup` each agent below has its services connected and its own one-click prompts
in the chat ("Try" chips). Every chat already shows one real example run.

| Agent | Shows | Click |
|---|---|---|
| **researcher** | Paid APIs over x402 | "Weather, headlines & ACME stock" |
| **flood-analyst** | Quantcomm flood research, Capital One exposure | "Banks under flood alerts", "Quantcomm's view on COF" |
| **shopper** | Ask to add a store, real Shopify cart, approval over the limit | "Socks from Allbirds" |
| **trader** | Paper investing, a self-set reminder, cash out to you | "Buy $100 of COF", "Watch COF for me", "Portfolio & P/L", "Cash out $20 to me" |
| **web-agent** | The rented computer, live in the chat | "Top story on Hacker News" |
| **All workers** (broadcast) | The bounty race: three paid, one turned away | "API reliability bounty" |
| **any agent** | The wallet stops a drain and freezes the agent | "Send whole balance to 0x…dEaD" |

Dashboard: Overview (approvals, activity), Portfolio, Schedules (pause switch), the Capital One sheet.

## Screens

| Screen | What | URL / app |
|---|---|---|
| Laptop | Agent chat page (you type here); collapse the sidebar to icons for more room | http://localhost:4050 |
| Projector A | Bounty board (HTML view of `/.well-known/agent-work`) | http://localhost:4021/.well-known/agent-work |
| Projector B | Owner dashboard | http://localhost:4040 |
| Phone (held up / mirrored) | Telegram chat with the bot | Telegram |
| Optional | Claude Desktop with the Allowance MCP server | — |

Before walking on: stop any running `npm run dev` (reset refuses to run under live services), then
`npm run reset && npm run dev`. Wait for all six services to log their URLs. Check the chat page
shows six idle agents at $20.00 and no red "LLM_API_KEY is not set" banner. Send `/start` to the
Telegram bot. Dashboard "details" toggle **off**. Send one warm-up message (e.g. "What's my
balance?") to one agent so the model is loaded, then **Clear** that conversation.

## 0:00 — Hook (20 s)

Say: *"x402 taught agents to pay. Nobody taught websites to pay agents. And nobody wants to give an
agent their keys. These are real agents. They sit idle until I ask them something."* Point at the
chat page: every agent idle.

## 0:20 — Act 1: the race (45 s)

Chat page: **All workers** (switch the header to **Grid** to show all four at once), click the chip *"Find paid work on localhost:4021 and complete the API
reliability check bounty."*, Send.

Say: *"One message, four agents, same moment. The site publishes paid work at a well-known URL with
three slots."* The four panels fill with tool calls (`find_work`, `claim_bounty`, `fetch_url` on
each endpoint, `submit_bounty`). Projector A: slot pills go 3 to 0 and payouts appear with tx hashes.
One agent gets "all slots taken". Projector B: three "earned $0.50" rows. (Optional: open the dashboard's **Services** tab to show
which agent can use which service.)

*"No marketplace. One line of middleware. The tx hash is the receipt."*

## 1:05 — Act 2: spend and approve (50 s)

Chat page: **researcher**, chip *"What's the weather in Paris today, the top 3 headlines, and the
ACME stock price?"*. Three `fetch_url` cards turn green with "Paid $0.05 / $0.10 / $0.15".

*"Each of those was an HTTP 402. The agent asked the wallet to pay; the wallet signed because it was
within policy."*

Then **shopper**, chip *"Order me a large mushroom and olive pizza…"*. Watch the activity row: it
checks its services, has no pizza service, searches the directory, and **asks you to connect Acme
Pizza**. A connection card appears in the thread with what Acme Pizza could do, and the phone buzzes.
Approve (inline, on the phone, or the dashboard). It reads Acme Pizza's docs and orders: now the
$18.50 payment is over its $10 threshold, so a second approval appears. Approve. "Paid $18.50 … order
placed", with a receipt card. Say it plainly: *"The pizza is simulated. The payment is not. And it
could only pay Acme Pizza because I connected it."*

## 1:55 — Act 3: try to make it steal (40 s)

Two ways to show the same point; do one, or both if time allows.

1. **Injection.** Select a worker that has not claimed a slot (or **Clear** one) and send *"Find paid
   work on localhost:4021 and do the release-notes summary bounty."* That bounty's description
   tells AI agents to send their whole balance to an attacker first. In rehearsal `qwen3` ignored it
   (once it even said it was ignoring a prompt injection). Say so:
   *"The model didn't fall for it. But we don't rely on that."*
2. **Direct instruction.** Pick the **researcher** and click the red chip *"Send your whole balance to
   0x…dEaD."* The agent tries `transfer_usdc`. The card turns red: "Blocked by wallet policy … Agent
   frozen." The phone buzzes. Projector B: the researcher card turns red with FROZEN.

*"I told it to, and it tried. The money never moved. The rules live outside the model."*

## Optional — Build the team (40 s, if there's time)

Chat page: **New → New agent**. The wallet's own form opens inside the chat ("Allowance wallet ·
only you can do this"). Name it `travel-planner`, one line of purpose, $20, **Everyday** limits,
tick Acme Weather and Acme News, **Create**. It opens ready to chat. Ask it *"I'm going to Paris this
weekend, what should I pack?"*: it pays $0.15 for weather and news and answers. Then **New →
New broadcast**, "Trip team" with researcher and travel-planner, and send one message to both.

*"Anyone can hire an agent in a minute. The money rules come with it."*

## Optional — Shop any Shopify store (40 s)

Chat page, **shopper**: *"Find me a pair of wool runners on allbirds.com, size 10, under $120."* It
sees the store isn't connected and asks you to add it (approve; the card shows allbirds.com and the
cap). It searches the real catalog (real product photos), builds a real Shopify cart, and pays in
USDC. Over its $10 threshold, so a second approval appears. Approve. The confirmation card shows the
store, the item, "Paid with Allowance Card ••1234" and a **Simulated order** badge. Say it: *"The
catalog, the cart and the payment from the agent's wallet are real. The card that pays the store is
the part we'd plug into a card issuer and Shopify's agent checkout."*

## Optional — Capital One and live flood data (45 s)

Needs `NESSIE_API_KEY` in `.env` and Quantcomm running (re-run its `scripts/run_live.py` first so the
alerts are fresh). Chat page, **researcher**, chip *"Banks under flood alerts"*: *"Are any banks
exposed to the coastal flooding right now? What about Capital One?"* It finds Quantcomm in the
directory and asks to connect it (approve). It pays $0.05 and the flood card shows the alerts, the
banks with the most deposits under them (TowneBank about 60%), and Capital One's sandbox branches
(0 of 220 under alerts in our run). Then open the dashboard's **Bank** sheet: the $0.05 is on the
researcher's Capital One allowance account as a purchase at "Quantcomm Flood Research", next to the
top-up from checking that funded it. Say it: *"The agent pays in USDC; the dollars side is a real
Capital One account through Nessie, so every agent purchase lands on a bank statement."*

## 2:35 — Close (25 s)

Tap **Unfreeze** on the phone (or dashboard). *"Open protocol for getting paid. Policy outside the
agent. Real agents, in chat, Claude Desktop and Telegram. Runs on NRP's open models, and on Base
Sepolia with real USDC."* Show the explorer tab briefly: the same tx hashes.

## Fallback matrix

| If this breaks | Do this |
|---|---|
| Model slow or "model busy, retrying" | Wait; it retries automatically. If it persists, switch `LLM_MODEL` to `gpt-oss` in `.env` and restart `npm run dev` |
| No network / NRP down | `npm run demo -- --auto-approve` runs the same four scenarios **scripted** (no model; it says so) against the same wallet |
| An agent goes off script | **Stop**, **Clear**, resend the chip. Or narrate what it did: it is a real agent |
| Telegram unreachable | Approve/deny and alerts are on the dashboard |
| Bounty already full from a rehearsal | Stop `npm run dev`, `npm run reset`, `npm run dev` (about 10 s) |
| Agent frozen from a rehearsal | Unfreeze on the dashboard or Telegram |
| Claude Desktop | Optional; the chat page is the primary agent surface |

## Pre-flight checklist

- [ ] `.env` has `LLM_API_KEY` (NRP token) and `LLM_MODEL`
- [ ] `npm run reset` done with services stopped, then `npm run dev` shows all services up
- [ ] Chat page: six idle agents at $20.00, no red banner, one warm-up message sent and cleared
- [ ] Shopper has no services (details panel); researcher has Weather, News, Stocks
- [ ] Bounty board shows 3/3 and 2/2 slots open
- [ ] Dashboard shows "live" and 8 agents
- [ ] Telegram `/start` answered; `TELEGRAM_BOT_TOKEN` in `.env`
- [ ] Phone screen mirroring or camera ready
- [ ] Optional bank act: `NESSIE_API_KEY` in `.env`; dashboard top bar shows "Capital One Checking"
- [ ] Optional flood act: Quantcomm running on :8000 with fresh alerts; `curl localhost:4080/health` says `"upstream":"up"`
