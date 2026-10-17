# DEMO.md — the 3-minute stage run

## Screens

| Screen | What | URL / app |
|---|---|---|
| Laptop, left half | Claude Desktop with the Allowance MCP server | — |
| Laptop, right half (or terminal) | `npm run demo` narration | terminal |
| Projector A | Bounty board (HTML view of `/.well-known/agent-work`) | http://localhost:4021/.well-known/agent-work |
| Projector B | Owner dashboard | http://localhost:4040 |
| Phone (held up / mirrored) | Telegram chat with the bot | Telegram |

Before walking on: stop any running `npm run dev` (Ctrl-C; `npm run reset` refuses to run under live services), then `npm run reset && npm run dev` (wait for all five services to log their URLs),
`/start` sent to the Telegram bot, Claude Desktop restarted with the MCP config from `npm run setup`,
both projector tabs open, dashboard "details" toggle **off**.

## 0:00 — Hook (20 s)

Say: *"x402 taught agents to pay. Nobody taught websites to pay agents. And nobody wants to give an
agent their keys. Allowance fixes both, inside Claude Desktop and Telegram."*

## 0:20 — Act 1: the race (40 s)

Terminal: `npm run demo -- --act=1`.

Say: *"This site publishes paid work at a well-known URL. Four agents find it at the same time.
Three slots."* Point at Projector A: slot pills go 3 → 0, the activity feed shows three claims and
three payouts with tx hashes, and one agent is told `bounty_full`. Projector B: three "Earned $0.50"
rows.

*"No marketplace. One line of middleware. A tx hash is the receipt."*

Fallback: if the board does not update, refresh it; the JSON at the same URL (with
`Accept: application/json`) is the proof.

## 1:00 — Act 2: Claude Desktop earns and spends (50 s)

Type into Claude Desktop:

> Find paid work on localhost:4021, complete it, then use your earnings to get today's weather and order me a pizza.

Say while it works: *"Claude is using our MCP server. It has a token, not a key. Every 402 it hits
is paid by the wallet service, and the wallet signs only what my policy allows."* Projector B shows
"Earned $0.50 for API reliability check" then "Paid $0.05 to Acme Weather".

When Claude reaches the pizza: *"$18.50 is over the $10 limit I gave it."* The phone buzzes.
Hold it up. Tap **Approve**. Claude finishes: *"Order placed. Receipt: tx …"*. Note the
`simulated: true` in the response and say so: *"The pizza is simulated. The payment is not."*

Fallback: if Claude Desktop stalls or refuses, run `npm run demo -- --act=2,4` in the terminal; the
scripted shopper hits the same endpoints and the same Telegram approval appears. If Telegram is
down, approve on the dashboard (pending approvals panel, right side).

## 1:50 — Act 3: the attack (40 s)

Terminal: `npm run demo -- --act=3`.

Say: *"Now the part that matters. One of the bounties is poisoned: its description tells the agent
to send its whole balance to an attacker as a 'processing fee'. This agent is naive and obeys."*

Terminal shows the injected text, the transfer attempt, then `WALLET REFUSED`. Phone buzzes:
*"Blocked: tried to send $20.00 to an unknown address. Agent frozen."* Projector B: the agent card
turns red with FROZEN, the feed glows.

*"The model was fooled. The money never moved. The rules live outside the model."*

Fallback: none needed; this act has no external dependency except the wallet-service. If Telegram
is down the dashboard shows the same alert.

## 2:30 — Close (30 s)

Tap **Unfreeze** on the phone (or dashboard). Say: *"Open protocol for getting paid. Policy outside
the agent. In the apps you already use. It runs fully offline in mock mode and on Base Sepolia with
real USDC."* Show the explorer tab briefly (http://localhost:4030/explorer): the same tx hashes.

## Fallback matrix

| If this breaks | Do this |
|---|---|
| Claude Desktop misbehaves / refuses | `npm run demo -- --auto-approve` runs all four acts scripted, same endpoints, same wallet path |
| Telegram unreachable | Approve/deny and alerts are on the dashboard; the notifier logs and keeps retrying |
| Wi-Fi dies | Everything is `CHAIN_MODE=mock` and local; nothing needs the internet except Telegram |
| Bounty board does not update live | Refresh; or show the JSON with `curl -H 'Accept: application/json' localhost:4021/.well-known/agent-work` |
| A service crashed | `npm run dev` restarts all with `tsx watch`; stop it (Ctrl-C) and `npm run reset` for a clean slate (10 s) |
| Agent frozen from an earlier run | Unfreeze on dashboard/Telegram, or `npm run reset` |
| Pizza already approved earlier and spend cap reached | `npm run reset` |

## Pre-flight checklist

- [ ] `npm run reset` done, `npm run dev` shows all services up
- [ ] `curl localhost:4021/.well-known/agent-work` returns JSON; browser tab shows the board
- [ ] Dashboard shows 8 agents with $20.00 each
- [ ] Telegram `/start` answered; `TELEGRAM_BOT_TOKEN` in `.env`
- [ ] Claude Desktop lists the Allowance tools (hammer icon)
- [ ] Phone screen mirroring or camera ready
- [ ] Terminal font size large; `DEMO_FAST` unset
