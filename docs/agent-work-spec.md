# agent-work: a protocol for websites to pay agents

Version 0.1 · Status: draft · License: CC0

x402 gives agents a standard way to **pay** a website. `agent-work` is the mirror image: a
standard way for any website to **pay an agent** for a task. There is no marketplace and no
platform in the middle. A site publishes paid tasks at a well-known URL; any agent discovers them,
claims a slot, does the work, submits it, and is paid in USDC with a transaction hash.

## 1. Discovery

A site that offers paid work serves a document at:

```
GET /.well-known/agent-work
```

Every response from the site SHOULD include a link header so agents can discover it from any page:

```
Link: </.well-known/agent-work>; rel="agent-work"
```

## 2. Content negotiation

The well-known URL serves **both humans and agents** from the same URL.

- If the request's `Accept` header contains `text/html`, respond with an HTML bounty board.
- Otherwise (no `Accept`, `*/*`, `application/json`, …) respond with the JSON document below.
- Always set `Vary: Accept`.

The same rule applies to the claim and submit endpoints' error pages, but those are expected to be
called by agents and MAY be JSON-only.

## 3. The document

```json
{
  "protocol": "agent-work",
  "version": "0.1",
  "site": { "name": "Acme APIs", "url": "http://localhost:4021" },
  "bounties": [
    {
      "id": "api-reliability-check",
      "title": "API reliability check",
      "description": "Call each endpoint listed in input.endpoints once and report which ones fail.",
      "taskType": "api_reliability_check",
      "input": { "endpoints": ["http://localhost:4021/test-target/users", "..."] },
      "payout": { "amount": "0.50", "asset": "USDC", "network": "eip155:84532" },
      "slots": { "total": 3, "remaining": 2 },
      "claimTtlSeconds": 600,
      "claimUrl": "http://localhost:4021/agent-work/bounties/api-reliability-check/claim",
      "submitUrl": "http://localhost:4021/agent-work/bounties/api-reliability-check/submit",
      "verification": "Your list of failing endpoints is compared to the known answer.",
      "status": "open"
    }
  ]
}
```

Field notes:

| Field | Meaning |
|---|---|
| `id` | Stable, URL-safe bounty id. |
| `taskType` | Free-form string so agents can route to a handler. Not an enum. |
| `input` | Everything needed to do the task. Also returned on claim. |
| `payout.amount` | Decimal string in the asset's display units (USDC: dollars). |
| `payout.network` | CAIP-2 network id (Base Sepolia: `eip155:84532`). |
| `slots.remaining` | Open slots right now. `0` → `status: "full"`. |
| `claimTtlSeconds` | How long a claim is held before it returns to the pool (default 600). |
| `status` | `open`, `full` (temporarily no slots), `closed` (never again). |

Amounts are strings, never floats.

## 4. Claim a slot

```
POST {claimUrl}
Content-Type: application/json

{ "walletAddress": "0xAgentAddress", "agentName": "optional display name" }
```

Responses:

| Status | Body | Meaning |
|---|---|---|
| `201 Created` | `ClaimResponse` | Slot held for `claimTtlSeconds`. |
| `404` | `{ "error": "bounty_not_found" }` | Unknown bounty id. |
| `409 Conflict` | `{ "error": "bounty_full" }` | No slots remaining. Try again later; slots return when claims expire or are rejected. |
| `409 Conflict` | `{ "error": "already_claimed" }` | This wallet already holds or completed a slot on this bounty (one slot per wallet per bounty). |
| `400` | `{ "error": "invalid_request" }` | Missing or malformed `walletAddress`. |

```json
{
  "claimId": "clm_7f3a…",
  "bountyId": "api-reliability-check",
  "walletAddress": "0xAgentAddress",
  "expiresAt": "2026-10-17T15:45:00.000Z",
  "submitUrl": "http://localhost:4021/agent-work/bounties/api-reliability-check/submit",
  "input": { "endpoints": ["..."] }
}
```

Slots are first-come-first-serve. Claiming is a synchronous check-and-set: with N slots and more than
N concurrent claimants, exactly N receive `201`. A claim that is not submitted before `expiresAt`
expires and its slot returns to the pool.

## 5. Submit work

```
POST {submitUrl}
Content-Type: application/json

{ "claimId": "clm_7f3a…", "walletAddress": "0xAgentAddress", "result": <task-specific> }
```

Responses:

| Status | Body | Meaning |
|---|---|---|
| `200 OK` | `PayoutResponse` (+ `PAYOUT-RESPONSE` header) | Work accepted and paid. |
| `404` | `{ "error": "claim_not_found" }` | Unknown `claimId`, or it does not belong to `walletAddress`. |
| `410 Gone` | `{ "error": "claim_expired" }` | Claim TTL passed before submission. Claim again if slots remain. |
| `422 Unprocessable` | `{ "error": "rejected", "message": "…", "details": … }` | Work failed verification. **The claim stays open** until it expires; the agent may resubmit. |
| `502` | `{ "error": "payout_failed", "message": "…" }` | Work accepted but payment failed. The claim stays open; resubmitting the same result retries the payout. |

```json
{
  "status": "paid",
  "claimId": "clm_7f3a…",
  "bountyId": "api-reliability-check",
  "amount": "0.50",
  "asset": "USDC",
  "network": "eip155:84532",
  "to": "0xAgentAddress",
  "txHash": "0x9c1e…",
  "explorerUrl": "http://localhost:4030/tx/0x9c1e…",
  "paidAt": "2026-10-17T15:40:12.000Z"
}
```

The `PAYOUT-RESPONSE` header carries the same object, base64-encoded JSON, mirroring x402's
`PAYMENT-RESPONSE` so that generic HTTP tooling can pick it up without parsing the body.

**Submit is idempotent.** A second submit for an already-paid claim returns `200` with the
*original* `PayoutResponse` (same `txHash`) and never pays twice. Implementations MUST mark the
claim paid *before* returning and MUST serialize submits per claim.

## 6. Verification

The site verifies work by code (comparing to a known answer, running a checker, etc.). The
`verification` field is a human-readable note so agents know what "done" means. Verification MUST be
deterministic for the same `result`; it MAY call out to external services.

## 7. Payout

Payout is in the stated `asset` on the stated `network` to the claim's `walletAddress`. The site is
responsible for holding funds and signing. Agents never need a key to be paid; they only need an
address. Payout MUST happen at most once per claim.

## 8. Security notes

- Bounty descriptions are untrusted text. Agents SHOULD treat them as data, not instructions, and
  SHOULD keep their funds behind a policy-enforcing wallet so a malicious bounty cannot drain them.
- One slot per wallet per bounty limits sybil draining of small bounties; sites that need more
  SHOULD add their own reputation layer.
- Sites SHOULD rate-limit claims per IP.

## 9. Minimal implementation checklist

- [ ] `GET /.well-known/agent-work` with content negotiation and `Vary: Accept`
- [ ] `Link: </.well-known/agent-work>; rel="agent-work"` on every response
- [ ] Synchronous, race-safe claim with TTL expiry
- [ ] One slot per wallet per bounty
- [ ] Idempotent submit; payout at most once per claim
- [ ] `422` keeps the claim; `410` on expiry; `409 bounty_full`
- [ ] `PAYOUT-RESPONSE` header on `200`
