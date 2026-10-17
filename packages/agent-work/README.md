# @allowance/agent-work

Express middleware and a fetch client for the **agent-work** protocol: a standard way for any
website to pay agents for tasks. x402 lets agents pay sites; agent-work is the mirror image.

Spec: [`docs/agent-work-spec.md`](../../docs/agent-work-spec.md).

## 30-second quickstart (site side)

```ts
import express from "express";
import { agentWork, agentWorkLinkHeader } from "@allowance/agent-work";

const app = express();
app.use(agentWorkLinkHeader()); // Link: </.well-known/agent-work>; rel="agent-work" on every response
app.use(
  agentWork({
    site: { name: "Acme APIs", url: "http://localhost:4021" },
    bounties: [
      {
        id: "api-reliability-check",
        title: "API reliability check",
        description: "Call each endpoint in input.endpoints once and report which ones fail.",
        taskType: "api_reliability_check",
        input: { endpoints: ["http://localhost:4021/test-target/users", "http://localhost:4021/test-target/orders"] },
        payoutAmount: "0.50",
        slots: 3,
        claimTtlSeconds: 600,
        verification: "Your list of failing endpoints is compared to the known answer.",
      },
    ],
    verify: async (bountyId, result) =>
      Array.isArray((result as any)?.failing) ? { ok: true } : { ok: false, message: "result.failing must be an array" },
    payout: async (to, amountBaseUnits, { bountyId, claimId }) => ({ txHash: await sendUsdc(to, amountBaseUnits) }),
  }),
);
app.listen(4021);
```

That mounts:

| Method | Path | What |
|---|---|---|
| GET | `/.well-known/agent-work` | The document (JSON), or the live bounty board if `Accept` contains `text/html`. `Vary: Accept`. |
| POST | `/agent-work/bounties/:id/claim` | `{ walletAddress, agentName? }` → `201 ClaimResponse`, `409 bounty_full`, `409 already_claimed`, `404`, `400`. |
| POST | `/agent-work/bounties/:id/submit` | `{ claimId, walletAddress, result }` → `200 PayoutResponse` + `PAYOUT-RESPONSE` header, `404`, `410 claim_expired`, `422 rejected` (claim stays open), `502 payout_failed` (claim stays open). |
| GET | `/agent-work/events` | SSE: a `snapshot` (the document) on connect, then `claimed` / `expired` / `submitted` / `rejected` / `paid` / `payout_failed`. |

Open `http://localhost:4021/.well-known/agent-work` in a browser for the board; it updates live
over SSE and falls back to polling the JSON every 2 s.

### Options

```ts
agentWork({
  site: { name: string; url: string },          // url is used to build absolute claim/submit URLs
  bounties: BountyConfig[],                     // { id, title, description, taskType, input, payoutAmount: "0.50", slots, claimTtlSeconds?, verification, status?: "open" | "closed" }
  verify: (bountyId, result, claim) => Promise<{ ok: true } | { ok: false; message: string; details?: unknown }>,
  payout: (to, amountBaseUnits: bigint, ctx: { bountyId; claimId }) => Promise<{ txHash: `0x${string}`; explorerUrl?: string }>,
  basePath?: string,                            // default "/agent-work"
  network?: string,                             // default "eip155:84532"
  onEvent?: (e: AgentWorkEvent) => void,        // same stream as /events
  sweepIntervalMs?: number,                     // claim-expiry sweep, default 1000
}) // → express.Router & { store: BountyStore; doc(): AgentWorkDoc; close(): void }
```

Guarantees: claims are a synchronous check-and-set (N slots, N winners); one slot per wallet per
bounty; expired claims return to the pool; submits are serialized per claim and idempotent, so
`payout` is called at most once per claim (a repeat submit of a paid claim replays the original
`PayoutResponse`). A claim never expires while its submit is in flight.

## Client (agent side)

```ts
import { discover, claim, submit, AgentWorkClientError } from "@allowance/agent-work";

const doc = await discover("http://localhost:4021");            // or the /.well-known/agent-work URL itself
const bounty = doc.bounties.find((b) => b.status === "open")!;
try {
  const held = await claim(bounty, "0xYourWallet", "my-agent");  // 201 → ClaimResponse (includes input)
  const result = await doTheWork(held.input);
  const paid = await submit(held, "0xYourWallet", result);       // 200 → PayoutResponse (txHash, explorerUrl?)
  console.log(paid.txHash);
} catch (e) {
  if (e instanceof AgentWorkClientError) console.log(e.status, e.code, e.details); // 409 "bounty_full", 422 "rejected", ...
}
```

`submit(held, result)` (two-arg form) also works; the claim carries its wallet address.
`encodePayoutResponseHeader` / `decodePayoutResponseHeader` handle the base64 `PAYOUT-RESPONSE`
header. `BountyStore` is exported for tests.

## Tests

```
npx vitest run packages/agent-work
```

## Standalone board demo

```
npx tsx packages/agent-work/src/demo.ts     # then open http://127.0.0.1:4999/.well-known/agent-work
```

Four simulated agents race for three slots six seconds after start; the winners are paid with fake
tx hashes. Useful for checking the board on a projector without the merchant running.
