# @allowance/dashboard

The owner's second screen. A projector-first web dashboard that shows, in dollars only,
what every agent is doing with its allowance, and lets the owner approve, deny, freeze,
unfreeze, create new agents and add money. It talks to the wallet-service (and, after creating an
agent, hands its token to the agent chat server).

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
| `?mock=1&chain=base-sepolia` | The mock reports chain mode: top-ups answer 501, so you can see the "fund this address" screens. |
| `?mock=1&bank=off\|low\|down\|unlinked` | Capital One (§16). The mock has a linked bank by default: checking ••1234 funded each agent's $20 allowance account, payments and earnings post a moment after they settle (statuses go pending → executed), the second settled payment fails ("Not on statement · Retry"). `off` is a wallet without a Nessie key (the dashboard looks as it did before §16), `low` leaves $12.40 in checking (a $20 top-up answers `409 bank_insufficient_funds`), `down` is Nessie not answering (`502 bank_unavailable`, stale balances, postings wait), `unlinked` has a key but no customer yet. |

`VITE_AGENT_CHAT_URL` (default `http://localhost:4050`) is the chat server: new agents are
registered there, embedded sheets post to its origin (and its `localhost`/`127.0.0.1` twin), and
the dev server's `frame-ancestors` follows it.

The mock (`src/api/mockAdapter.ts`) seeds the eight demo agents (`claude-desktop`,
`researcher`, `shopper`, `naive-worker`, `worker-1..4`, $20 each) with the default connected
services of §13.2, serves the six directory services of §13.1, and emits an event every 2–4 s:
a scripted opening (bounty earnings, small API payments, a $18.50 pizza that waits for your
approval, one poisoned-bounty block that freezes `naive-worker`, **shopper asking to connect Acme
Pizza**, researcher proposing a custom "Hacker News Digest" service, then the owner creating
`translator` with $10 and Acme News), then a steady random mix (agents only pay services they have
connected). It also creates agents and tops up with the wallet's rules and error codes (§14.2:
`409 agent_exists`, `400 invalid_request`, `404 service_not_found`, $0.01–$1000 top-ups), so both
owner sheets work against it. Deterministic for a given seed. Scripted
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
- **New agent** (agents column header) and **Add money** (each agent card) open the owner sheets
  below as right-hand sheets (`?sheet=new-agent`, `?sheet=add-money&agent=<name>`; Back closes).
  New agents appear live (`agent.created` + a summary refetch).

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

## Owner sheets (§14.3)

| URL | What |
|---|---|
| `/?sheet=new-agent` | Name (live check against `AGENT_NAME_RE`, the rule in words, "is it taken"), purpose (≤ 600 chars, becomes the chat role), avatar preview, starting money ($5/$10/$20/$50/custom ≤ $1000, test money), limits presets with editable numbers (Careful $1/$5/ask >$1 · Everyday $5/$25/$5 · Shopper $20/$50/$10 · Custom), services to connect (directory always included). `POST /v1/agents { name, policy:{ maxPerTx, dailyCap, approvalThreshold, allowlist:{addresses:[],origins:[]} }, initialBalance?, services }`, then `POST {chat}/api/agents { name, token, role? }`. Success: "travel-planner is ready" + balance + Open chat (`{chat}/?agent=<name>`). If the chat server can't take it, the token is shown **once** with Copy (clipboard API; the chat's iframe has `allow="clipboard-write"`, with a select-and-copy fallback), and the sheet can only be left with "Done, I saved the token". The token lives only in component state: never logged, stored, put in a URL or posted. |
| `/?sheet=add-money&agent=<name>` | Avatar + balance, chips + custom (≤ $1000), "Add $20 test money" → `POST /v1/agents/:id/topup`; shows the new balance and the receipt. No/unknown agent → pick one. Base Sepolia → "top-ups aren't available", the address to fund behind a details. With Capital One linked (§16.5): "From Capital One Checking ••1234 · $X available", "Move $20 from Checking", the bank's 409/502 in its own words, and "Moved $20.00 from Checking to shopper's allowance account". |
| `/?sheet=bank` | Capital One (§16.5): checking, every agent's allowance account with its balance, recent bank activity with each receipt's marker (failed first), the queue (`N posting · N not on statement`, Retry), the wallet's `error` when Nessie is unreachable, and Link when it has a key but no customer. Embeddable; embedded it follows `/v1/events`. |
| `/?sheet=agent&agent=<name>` | Dashboard only, opened from an agent card's Bank row or the bank sheet: "Capital One allowance account ••5678 · $X", the latest entries from `GET /v1/bank/statement?agentId=` (merchant, amount, date, Nessie's status) with a Nessie sandbox note, and its recent receipts with their markers. |

Add `&embed=1` for the chat: no app chrome, transparent page, a card that scrolls inside the iframe
if it is given less height than it asked for, `&theme=light|dark`. Embedded, the sheet posts to
`window.parent` at one `targetOrigin`, never `*` and never a token: the parent's real origin when
it is allowed (the chat on `localhost` or `127.0.0.1`, or the dashboard's own origin), learned from
`location.ancestorOrigins` or `document.referrer` (the chat's iframe sends
`referrerpolicy="origin"`), else the `VITE_AGENT_CHAT_URL` origin.

| Message | When |
|---|---|
| `{ type: "allowance:sheet-size", sheet, height }` | on load and every resize |
| `{ type: "allowance:agent-created", name }` | once the chat server hosts the new agent, or, if registration failed, when the owner presses "Done, I saved the token". Never while the token is on screen: the chat closes the sheet on this message |
| `{ type: "allowance:money-added", name, amount }` | after a top-up (`amount` = `"20.00"`) |
| `{ type: "allowance:sheet-close", sheet }` | Cancel, the close button, Escape, "Start chatting", Done (after `agent-created` on the token screen) |

Typical heights at 390 px wide: New agent ≈ 1480 (form), 470 (ready), 760 (token); Add money ≈ 330
(form), 580 (done). Try them against the mock: `/?sheet=new-agent&embed=1&mock=1&theme=dark`.

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
  bank.ts               Capital One (§16): bank lines, receipt markers, bank events, statements (pure)
  embed.ts              approval embed postMessage contract (pure)
  sheets.ts             owner sheets: name/amount/limits checks, presets → policy, sheet URLs, chat
                        registration, sheet postMessage contract (pure)
  route.ts, theme.ts    hash routes (+ ?sheet= hook), theme preference
  useWallet.ts          the one stateful hook (+ useNow); useAdapter.ts for standalone embeds
  Embed.tsx             the approval embed; EmbedSheet.tsx the embedded owner sheets
  components/           TopBar, AgentCard, ActivityFeed, ApprovalCard, ApprovalsPanel, ReceiptsList,
                        ServicesView, ServiceSheet, NewAgentSheet, AddMoneySheet, SheetParts,
                        BankSheet, AgentSheet, BankParts, Switch, Avatar, Icons
  styles/base.css       tokens (dark + light), reset, buttons
  styles/app.css        layout + overview + motion
  styles/services.css   approval cards, gallery, sheet, embed
  styles/sheets.css     owner sheets (dashboard sheet + chat embed)
  styles/bank.css       Capital One: top bar checking, bank rows, markers, statements, bank sheet
  *.test.ts             vitest (node): format, state, services, embed, sheets, bank, mockAdapter
```

Agent avatars come from `@allowance/shared/avatars` (pure), so every UI shows the same face and
color per agent. The only other runtime import from the shared package is `AGENT_NAME_RE` /
`MAX_TOPUP`, taken from its pure `src/types.ts` by relative path (the main entry pulls in a
`node:fs` config loader; a test pins them to the package's exports).
