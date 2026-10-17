# @allowance/dashboard

The owner's second screen. A projector-first web dashboard that shows, in dollars only,
what every agent is doing with its allowance, and lets the owner approve, deny, freeze,
unfreeze and top up. It talks to the wallet-service only.

## Run

```sh
npm run dev --workspace apps/dashboard     # Vite on http://localhost:4040 (strict port)
npm run build --workspace apps/dashboard   # production build into apps/dashboard/dist
npx vitest run apps/dashboard              # unit tests (node environment, no DOM)
npx tsc -p apps/dashboard/tsconfig.json --noEmit
```

Vite proxies `/v1` to `http://localhost:4010` (override with `WALLET_SERVICE_URL`), so the
app only ever calls relative URLs and the SSE stream at `/v1/events` works through the
proxy unbuffered.

## Data source: live or demo

| How | What you get |
|---|---|
| default | HTTP adapter against the wallet-service. On load it checks `/v1/health`; if that fails it shows the banner **"Wallet service offline — showing demo data"** and uses the mock. |
| `http://localhost:4040/?mock=1` | Mock adapter, always. |
| `VITE_MOCK=1 npm run dev --workspace apps/dashboard` | Same, via env. `?mock=0` overrides back to HTTP. |

The mock (`src/api/mockAdapter.ts`) seeds the eight demo agents (`claude-desktop`,
`researcher`, `shopper`, `naive-worker`, `worker-1..4`, $20 each) and emits an event every
2–4 s: a scripted opening (bounty earnings, small API payments, a $18.50 pizza that waits
for your approval, one poisoned-bounty block that freezes `naive-worker`), then a steady
random mix. It is deterministic for a given seed, which is what the tests rely on.

## Layout (1280×720 without page scroll; each column scrolls on its own)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Allowance ● live   mock ledger      TOTAL BALANCE $161.35  spent  earned   ☐ details │
│ ▒▒ red banner when any agent is frozen: "naive-worker is frozen. Blocked: …" ▒▒  │
├──────────────┬────────────────────────────────────┬──────────────────────────┤
│ AGENTS       │ LIVE ACTIVITY (newest on top)      │ NEEDS YOUR APPROVAL      │
│ card/agent:  │ icon + friendly sentence + "12 s   │  $18.50  Approve / Deny  │
│ name, big    │ ago"; earned = green, blocked =    ├──────────────────────────┤
│ balance,     │ red glow + flash in, pending = amber│ RECEIPTS                 │
│ spent-today  │ with inline Approve / Deny         │ what, amount, agent,     │
│ meter vs cap,│                                    │ counterparty, status,    │
│ limits,      │                                    │ time                     │
│ FROZEN badge,│                                    │                          │
│ Freeze /     │                                    │                          │
│ Add $20(demo)│                                    │                          │
└──────────────┴────────────────────────────────────┴──────────────────────────┘
```

- Frozen agents float to the top of the agents column and get a red tint, a snowflake
  and the reason, plus the banner across the top. Impossible to miss from across a room.
- "details" in the top bar reveals addresses, tx hashes (as explorer links when the
  wallet-service provides `explorerUrl`), receipt ids and allowlists. Hidden by default.
- Money is always `$1,234.56`; never base units. Times are relative and refresh every second.
- The live dot reads `live`, `reconnecting` (EventSource is retrying; the snapshot is
  reloaded once it reconnects) or `demo data`.

## What each demo act looks like

1. **Race (bounty board).** `worker-1..4` rows pour in green: "Earned $0.50 for Bounty: API
   reliability check." Earned-today in the top bar climbs; receipts fill with `+$0.50`.
2. **Spend (Claude Desktop pays for APIs).** "Paid $0.05 to Acme Weather." rows for
   `claude-desktop`/`researcher`; the per-agent "spent today" meter creeps up. The
   "is paying" row collapses into the "Paid" row once the payment settles.
3. **Attack (poisoned bounty).** Two red rows flash in: "Blocked: tried to send $20.00 to an
   unknown address. Agent frozen." and "naive-worker is frozen." The agent's card jumps to
   the top of the agents column with a red FROZEN badge, and a red banner spans the top bar.
   The owner clicks Unfreeze when ready.
4. **Pizza ($18.50 > $10 threshold).** An amber row "shopper wants to pay $18.50 to Acme
   Pizza. Needs your approval." with inline Approve / Deny, mirrored by a large card in the
   right column. Approve (here or in Telegram) → "Approved $18.50 …" → "Paid $18.50 …".

## State flow

`src/useWallet.ts` picks the adapter, loads `summary + events/recent + receipts +
approvals`, then subscribes. Each SSE event goes through the pure reducer in
`src/state.ts` (updates agents' frozen state, approvals, receipts, feed capped at 200);
money events trigger a 500 ms debounced `/v1/summary` refetch so balances and totals are
always the ledger's truth.

## Files

```
src/
  api/adapter.ts        WalletAdapter interface + ?mock=1 / VITE_MOCK selection
  api/httpAdapter.ts    fetch + EventSource against /v1 (named SSE events)
  api/mockAdapter.ts    deterministic in-memory wallet-service
  state.ts              reducer + applyEvent (pure)
  format.ts             money / relative time / friendly sentences (pure)
  useWallet.ts          the one stateful hook (+ useNow)
  components/           TopBar, AgentCard, ActivityFeed, ApprovalsPanel, ReceiptsList, Icons
  styles/base.css       tokens, reset, buttons
  styles/app.css        layout + components + motion
  *.test.ts             vitest (node): format, state, mockAdapter
```
