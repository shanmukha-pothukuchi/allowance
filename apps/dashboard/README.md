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
| default | HTTP adapter against the wallet-service. If `/v1/health` fails it says **offline** and retries every 2 s. It never falls back to demo data (§12). |
| `http://localhost:4040/?mock=1` | Mock adapter, always, behind a "Demo data" banner. |
| `VITE_MOCK=1 npm run dev --workspace apps/dashboard` | Same, via env. `?mock=0` overrides back to HTTP. |

The mock (`src/api/mockAdapter.ts`) seeds the eight demo agents (`claude-desktop`,
`researcher`, `shopper`, `naive-worker`, `worker-1..4`, $20 each) with the default connected
services of §13.2, serves the six directory services of §13.1, and emits an event every 2–4 s:
a scripted opening (bounty earnings, small API payments, a $18.50 pizza that waits for your
approval, one poisoned-bounty block that freezes `naive-worker`, **shopper asking to connect Acme
Pizza**, researcher proposing a custom "Hacker News Digest" service), then a steady random mix
(agents only pay services they have connected). Deterministic for a given seed. Scripted
approvals have fixed ids (`apr_demo_pizza`, `apr_demo_connect`, `apr_demo_custom`) so the embed
works against the mock too.

## Views

`#/` **Overview** and `#/services` **Services** (tabs in the top bar; the Overview tab shows an
amber count while approvals wait). Dark by default; light when the OS prefers it, or with the
sun/moon toggle (remembered) or `?theme=light|dark`.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ◎ Allowance [Overview ②|Services]   TOTAL $161.35  spent  earned   ● live ☀ details │
│ ▒▒▒ solid red banner while any agent is frozen: "naive-worker is frozen. Blocked: …" ▒▒▒ │
├───────────────┬───────────────────────────────────┬──────────────────────────────┤
│ AGENTS        │ LIVE ACTIVITY (newest on top)     │ NEEDS YOUR APPROVAL          │
│ 🛍️ shopper     │ avatar + event badge, sentence,   │ payment card: $18.50, to …   │
│ $20.00        │ agent · time · "by approval";     │ service card: 🍕 Acme Pizza,  │
│ spent/cap bar │ service rows show the service     │ permissions, price cap, the  │
│ limits        │ tile; inline Approve / Deny for   │ agent's reason (quoted, its  │
│ services 🌤️📰 │ waiting payments and requests     │ own words), custom warning   │
│ Freeze  $20   │                                   ├──────────────────────────────┤
│               │                                   │ RECEIPTS (avatar per row)    │
└───────────────┴───────────────────────────────────┴──────────────────────────────┘
```

- **One feed line per thing.** A settlement replaces its "is paying" row; a decision replaces
  its "Approve?" / "wants to connect" row; "Acme Pizza connected to shopper" replaces the
  "Approved connecting…" row; a policy freeze is folded into its block row (same
  `data.receiptId`, §6). Soft blocks (`service_not_connected`, `service_cap`,
  `insufficient_balance`) are calm, not red.
- **Frozen is impossible to miss:** solid red banner, red glowing card at the top of the column,
  snowflake badge on the avatar, red balance.
- Approval cards keep Approve / Deny pinned to the bottom of the panel when a tall service card
  does not fit (1280×720).
- **Services** is a connectors gallery: search (name, summary, description, provider, category),
  chips All / Data / Shopping / Work / Tools, a card per service with stacked avatars of the
  agents that have it, "N waiting for you" and "Proposed by <agent>" badges. A card opens a
  sheet (`#/services/<id>`): description, pricing, price cap, the base URL it may pay, what a
  connected agent can do, pending requests (approve here too), a switch per agent showing how it
  was connected ("by approval", "by you", "default"), and the usage docs. Agent-proposed services
  come from agents' `services` (`source:"agent"`), never the directory, and are flagged in orange.
- "details" in the top bar reveals addresses, tx hashes, receipt and approval ids.

## What each demo act looks like

1. **Race (bounty board).** `worker-1..4` rows pour in green: "Earned $0.50 for Bounty: API
   reliability check." Earned-today climbs; receipts fill with `+$0.50`.
2. **Spend.** "Paid $0.05 to Acme Weather." for `claude-desktop` / `researcher`; the spent-today
   bar creeps up. The "is paying" row collapses into the "Paid" row once it settles.
3. **Attack (poisoned bounty).** One red row flashes in: "Blocked: tried to send $20.00 to an
   unknown address. Agent frozen." The card jumps to the top in red with FROZEN and the reason,
   and the solid red banner spans the top. The owner clicks Unfreeze when ready.
4. **Connect a service.** An amber row "shopper wants to connect Acme Pizza." with inline Approve
   / Deny, mirrored by the service card in the right column (and in the chat via the embed).
   Approve → the row becomes "Acme Pizza connected to shopper · by approval" and a 🍕 tile appears
   on shopper's card and in the Services gallery.
5. **Pizza ($18.50 > $10 threshold).** An amber "wants to pay $18.50 to Acme Pizza" row and a
   big payment card. Approve (here, the chat, or Telegram) → "Approved $18.50 …" → "Paid $18.50 …".

## Approval embed (§13.5)

`/?approval=<id>&embed=1` renders one approval card (payment or service) and nothing else, on a
transparent background, for the agent chat to iframe. It posts
`{ type: "allowance:approval-size", id, height }` on load and every resize, and
`{ type: "allowance:approval", id, status }` once the approval is approved / denied / expired:
decided here, decided elsewhere (watched over SSE), or already decided when it loads. An unknown
id shows "not found" and posts no status. It follows `prefers-color-scheme` like the chat;
`&theme=light|dark` forces one (needed for a transparent iframe when the embedder's theme differs
from the OS). Add `&mock=1` to try it against the mock. The dev server sends
`Content-Security-Policy: frame-ancestors 'self' http://localhost:4050 http://127.0.0.1:4050`.

## State flow

`src/useWallet.ts` picks the adapter, loads `summary + events/recent + receipts +
approvals`, then the directory (a failure there never blocks the overview), then subscribes.
Each SSE event goes through the pure reducer in `src/state.ts` (agents' frozen state and
connected services, approvals of both kinds, receipts, feed capped at 200); money and connection
events trigger a 500 ms debounced `/v1/summary` refetch so balances and services are always the
wallet's truth. The gallery derives connections from `agents[].services`, so it is live even
though the directory is fetched once.

## Files

```
src/
  api/adapter.ts        WalletAdapter interface (+ directory, connect/disconnect, getApproval), ?mock / ?embed parsing
  api/httpAdapter.ts    fetch + EventSource against /v1 (named SSE events)
  api/mockAdapter.ts    deterministic in-memory wallet-service + directory
  state.ts              reducer + applyEvent + collapseFeed (pure)
  services.ts           catalog merge, search, labels (pure)
  format.ts             money / relative time / friendly sentences (pure)
  embed.ts              embed postMessage contract (pure)
  route.ts, theme.ts    hash routes, theme preference
  useWallet.ts          the one stateful hook (+ useNow)
  Embed.tsx             the approval embed
  components/           TopBar, AgentCard, ActivityFeed, ApprovalCard, ApprovalsPanel, ReceiptsList,
                        ServicesView, ServiceSheet, Switch, Avatar, Icons
  styles/base.css       tokens (dark + light), reset, buttons
  styles/app.css        layout + overview + motion
  styles/services.css   approval cards, gallery, sheet, embed
  *.test.ts             vitest (node): format, state, services, embed, mockAdapter
```

Agent avatars come from `@allowance/shared/avatars` (the only runtime import from the shared
package; it is pure), so every UI shows the same face and color per agent.
