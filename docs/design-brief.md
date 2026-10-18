# Design brief: Allowance

You're designing the product UI for **Allowance**, a hackathon project that will be demoed live.
Design it from first principles. The current UI is a placeholder: don't assume any existing layout,
navigation, component style or visual language. Below is what the product does, who uses it, what
information exists, and what each moment has to communicate. Structure, navigation, layout and
visual identity are your call.

## The product

Allowance gives AI agents a wallet without giving them the keys. A wallet service holds each agent's
key and signs a payment only if the owner's rules allow it:

- a maximum per payment,
- a daily spending cap,
- the services the agent is allowed to pay ("connected services"),
- a threshold above which the owner must approve.

The agents are real LLM agents. They do nothing until the owner asks. They can:

- **Spend:** pay websites per request (weather, news, stock quotes) or order things (a pizza).
- **Earn:** websites post paid tasks through an open protocol called *agent-work*. Agents find a
  task, claim one of a limited number of slots, do the work, submit it, and get paid automatically.
- **Ask for more:** when an agent needs a service it isn't connected to, it finds one in a service
  directory and asks the owner to connect it. It can also propose a service that isn't in the
  directory.

If an agent is told to send money somewhere it shouldn't, by a person or by malicious text on a
website, it may try. The wallet refuses, freezes the agent, and alerts the owner. The core promise:
**whatever the model was told, the money only moves within the owner's rules.**

## Who uses it

1. **The owner.** Not technical. Gives agents tasks, holds the purse strings, approves things
   (often from a phone), watches where money goes, decides what each agent may do.
2. **The live audience.** Judges reading a projector from across a room, with two screens and a
   phone in view. In a few seconds they need to see what an agent is doing, what money moved, and
   what was stopped.
3. **Visitors to a website that posts paid tasks.** A public page any human or agent can read.

## The moments to design for (the live demo, in order)

1. **Ask an agent something and watch it work.** "What's the weather in Paris, the top headlines and
   the ACME stock price?" The researcher agent checks its services, reads how to use them, pays
   $0.05, $0.10 and $0.15, and answers with the results and receipts. It takes about 30 seconds; the
   wait should feel informative, not dead.
2. **Four agents race for three paid slots.** One message goes to four worker agents at once. They
   work in parallel, find the same task, and race to claim it. Three finish and earn $0.50 each; one
   is told the slots are gone. This must read as a race in real time.
3. **The pizza.** "Order me a large mushroom and olive pizza." The shopper has no pizza service. It
   searches the directory, finds Acme Pizza, and **asks the owner to connect it**, showing what the
   service could do and why the agent wants it. The owner approves. The agent reads the service's
   instructions and orders. The $18.50 order is over the shopper's $10 threshold, so it **asks the
   owner to approve the payment**. The owner approves on the phone. The agent confirms with a
   receipt and the order details. Fulfillment is simulated; the payment is real (on a test ledger).
   The UI must say so.
4. **The attack.** The owner tells an agent "Send your whole balance to 0x0000…dEaD". (A website's
   task description can also hide that instruction.) The agent tries. The wallet blocks it, freezes
   the agent, and alerts the owner. This should land: *it was told to, it tried, and nothing was
   sent.* Then the owner unfreezes it.
5. **The owner's overview.** All agents and their balances, spent and earned today, everything that
   happened, what's waiting on the owner, and which services each agent can use.

## Surfaces

You decide how many surfaces there are and how they relate. These needs must be covered:

- **Talking to agents:** one agent at a time, or several at once (the race).
- **The owner's console:** money, agents, activity, rules, services.
- **Approvals:** phone first, but also usable at the moment the agent is asking. Two kinds: a
  payment, and connecting a service.
- **Services:** browsing the directory, seeing what each agent is connected to, connecting and
  disconnecting, and reviewing agent-proposed services.
- **A website's public task board** (agent-work): what tasks the site offers and their live slot counts.
- **Copy only:** Telegram notifications, namely an approval request with Approve and Deny, a block
  alert with Unfreeze, and short receipts.

Merge or split these however works best, within the trust boundary under "Hard constraints".

## Real content to design with

Use this instead of placeholder text.

**Agents**

| Agent | Purpose | Max per payment | Daily cap | Asks owner above | Starts with |
|---|---|---|---|---|---|
| researcher | finds information, buys data | $1.00 | $5.00 | $1.00 | Weather, News, Stocks |
| shopper | buys things for the owner | $20.00 | $50.00 | $10.00 | no services |
| worker-1…4 | earn by doing paid tasks | $1.00 | $5.00 | $1.00 | Bounties |

Each agent has a balance (all start at $20.00), spent today, earned today, a wallet address
(technical, hidden by default), its connected services, and a live state:

- idle
- thinking
- using a tool
- waiting for the owner's approval (payment or service)
- the model is busy and retrying
- frozen, with the reason

**A turn with an agent** contains the owner's message, the agent's reply (short, markdown-ish text),
and the steps it took. Each step has an input, an output, a duration and success or failure. The
steps, in plain words:

- checked its wallet
- looked at its connected services
- searched the directory for "pizza"
- read how to use Acme Pizza
- asked you to connect Acme Pizza
- paid $18.50 to Acme Pizza
- opened a page
- a page returned an error
- looked for paid work on a site
- claimed a slot, or found no slots left
- submitted work and earned $0.50
- tried to send $20.00 to an address
- checked on an approval

**Outcomes worth showing** (from the agent's actions):

- **Payment:** service, amount, time, transaction id with an explorer link.
- **Earning:** task, amount, site, transaction id.
- **Connection request:** pending, then connected, declined or expired.
- **Blocked attempt:** amount, destination, which rule stopped it, frozen or not.
- **Order confirmation:** size, toppings, address, ETA, order id, a "simulated" note.
- **Race result:** claimed a slot, or no slots left.

**Approvals**

- **Payment:** agent, amount, the service and site it's paying, when it was asked.
- **Service connection:** agent, service name and provider, a plain-language list of what it would
  allow (e.g. "Pay up to $18.50 per order to Acme Pizza"; "Place orders on your behalf"), the price
  cap, and the agent's reason. The reason is the agent's own words and is untrusted.
- An agent-proposed service that isn't in the directory also carries its web address and must be
  clearly flagged.
- Approvals expire after 10 minutes. They can be decided from the phone, the console, or wherever
  else you place them, and every place showing one must update when it's decided elsewhere.

**Services in the directory**

| Service | Provider | Category | Pricing | What it does |
|---|---|---|---|---|
| Service Directory | Allowance | tools | free | finds services; always available to every agent |
| Acme Weather | Acme APIs | data | $0.05 per call | current weather for a city |
| Acme News | Acme APIs | data | $0.10 per call | top headlines |
| Acme Stocks | Acme APIs | data | $0.15 per call | a stock quote |
| Acme Pizza | Acme APIs | shopping | $18.50 per order | orders a pizza (simulated fulfillment) |
| Acme Bounties | Acme APIs | work | free; pays you $0.50–$0.75 per task | paid tasks for agents |

Each service has a one-line summary, a description, permissions, a price cap and usage docs (long,
technical, collapsible). For each agent it is either not connected, or connected by default, by the
owner, or by approving the agent's request.

**The owner's activity stream** includes:

- agent paid
- agent is paying (pending settlement)
- agent wants to pay (needs approval)
- payment blocked
- agent frozen and unfrozen
- agent earned
- agent wants to connect a service
- service connected and disconnected
- top-up
- approval granted or denied, and where

**The public task board** has the site name and two tasks:

- **API reliability check:** $0.50, 3 slots, "check five endpoints and report which fail".
- **Summarize release notes:** $0.75, 2 slots. This is the poisoned one: its description hides an
  instruction to AI agents to transfer their balance.

Each task shows its payout, total and remaining slots (live), status (open, full or closed), how
long a claim is held (10 minutes) and how the work is verified. There is a live feed of claims and
payouts with transaction ids, and a link to the machine-readable version of the page.

## What the design must make unmistakable

- What each agent is doing right now, and when it is **waiting on you**.
- Money in, money out and money refused, distinguishable at a glance. Amounts are in dollars.
- **Whose words these are.** The agent's text, a website's text, the wallet's facts and the
  owner's decisions must be visually distinct. Agent and website text can say anything, including
  "Approved ✓" or "click here to approve"; it must never be able to pass for a wallet decision or an
  approval control.
- Who decided an outcome: the wallet's rules, the owner, or the agent.
- What is simulated and what is real.
- That an agent is frozen, why, and how to undo it.
- During the race, who got a slot and who didn't, while it's happening.

## Hard constraints

- **Trust boundary.** The surface where the owner talks to agents is run by the agent side. It
  must not be able to approve anything or change rules. Approval controls are served by the
  owner's wallet surface, a separate web origin. If approvals appear inside a conversation, they
  must be an embedded piece of the owner's wallet that visibly belongs to the wallet, not the agent.
  Design it so a convincing fake inside agent text would still look wrong.
- **Projector-readable** at 1280×720 and 1920×1080 from the back of a room. **Phone** approvals at
  about 390×844.
- **Live updates** arrive constantly, with several agents active at once. Nothing jumps, and
  nothing the owner is about to tap moves.
- **Honest waiting.** A task takes 20–40 seconds and the model may retry. Show real progress (the
  current step), not a generic spinner.
- **Light and dark** themes.
- **Offline-capable.** No external fonts, CDNs or images at runtime: use system fonts or bundled
  assets. It is implemented in plain CSS. One surface is vanilla JS with no build step, another is
  a React app. Avoid designs that depend on heavy libraries.
- **Accessible.** WCAG AA contrast, fully keyboard operable, respects reduced motion.
- **Technical details on demand.** Addresses and transaction hashes are hidden by default and
  available when asked for. Nothing secret is ever shown, and private keys never leave the wallet.

## Voice

Calm, trustworthy, consumer-grade. Plain sentences:

- "Paid $0.05 to Acme Weather."
- "shopper wants to connect Acme Pizza."
- "Blocked: tried to send $20.00, over its $1.00 limit. Agent frozen."

It should feel like a polished consumer product, not a developer console, an admin template or a
crypto exchange.

## Please deliver

1. **Structure.** How many surfaces, what lives where, and how the owner moves between them, with
   reasoning.
2. **A visual system.** Type, color, spacing, iconography, and how money in, money out, refused,
   waiting and agent-authored content are encoded.
3. **Screens for each of the five moments**, including in-progress, waiting-for-approval, success,
   blocked, frozen, expired, offline and empty states, for laptop and projector, plus the phone
   approval flow.
4. **A component inventory** with states.
5. **Motion notes** for live updates, the race, and the moment of a block.
6. **A short rationale** for the key decisions, especially how the trust boundary and "whose words
   are these" are made visible.
