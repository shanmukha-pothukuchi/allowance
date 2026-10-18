# UI rules (Linear-style)

Every Allowance surface follows these rules: the chat (:4050), the dashboard (:4040) and its embeds,
and the small pages (directory :4060, bounty board, merchant index, explorer, bridges). The
reference is Linear's issue view and agent panel. Colors and fonts stay as they are (the tokens in
`apps/agent-chat/static/chat.css` and `apps/dashboard/src/styles/base.css`); this is about
structure, density and saying each thing once.

## The rules

1. **One fact, one place.** A fact (a service name, a price, a cap, a balance, an account number, a
   status) appears once per view. If a card shows it, the text around the card doesn't repeat it,
   and the card doesn't repeat it inside itself either.
2. **Events are lines, not cards.** Something that happened is one muted line: small icon or
   avatar, then "**actor** did thing to **object** · 2m ago". Numbers sit right-aligned in tabular
   figures. No colored sentences: color is reserved for small status marks.
3. **Cards are for decisions and results.** Use a card only when the owner must act (approve,
   deny, retry) or when there is a real result to look at (products, a cart, an order, research).
   A card has a one-line header with the key fact, at most 3–4 body lines, and one primary action.
   The rest sits behind a disclosure ("Details", "Reasoning", "Show all").
4. **Muted meta, inline.** Secondary facts go on one line in `--text-3`, separated by " · ".
   Never stack three lines of meta when one fits.
5. **Status is a mark, not a phrase.** Use small marks: a dot, an icon or a short chip ("Pending",
   "Failed"). The normal, good state is quiet: a bank-posted payment shows a small check-bank icon
   with a tooltip, not "✓ On Capital One statement" on every row. Only problems get words.
6. **The agent's work is collapsed.** In the chat, "Worked for 12s ▸" holds every step and every
   interim sentence the agent said while working ("I'll look for…", "Found it…"). Only the agent's
   final reply shows as text, followed by at most one card per result.
7. **One accent.** Indigo (`--accent-fill`) is only for the single primary action in a view
   (Approve, Send). Secondary buttons are dark pills (`--fill`/`--fill-2`). Green and red are only
   for money signs and status marks. Amber is only for "waiting on you".
8. **Density with hierarchy.** Body is 13–14px. Titles are 15–16px semibold. Row height is about
   32–40px for single-line rows. Separators are 1px `--line`. Cards have 8–12px radius and 1px
   `--card-line`, and no shadow except popovers.
9. **Truncation is a smell.** If a title is truncated in a normal-width view, the card is carrying too
   much. Shorten the text rather than ellipsizing ("Connect Quantcomm?" not "Asked to connect
   Quantcomm Flood Re…").
10. **Empty and calm.** Leave space empty rather than filling it with explanations. Help text
    appears once, where it's needed, and never repeats what a label already says.

## Fix list (what is wrong today)

### Chat (`apps/agent-chat/static`)
- C1. Interim narration ("I'll look for a flood/weather or news service first.", "Found a service…",
  "That's the one — I'll ask you…") renders as main text next to the step list. It belongs inside
  the "Worked for…" disclosure. Show only the final reply.
- C2. The step list is a boxed list of two-line rows, with a duration and a check icon on every row and
  several "Thought it through" rows. Make it one muted line per step ("Searched the directory for
  'flood' · 1 result"). Drop the thinking rows (or fold them into one "Thought for 4s" line). Show the
  total time only on the summary line. Show icons only for waiting or failed steps.
- C3. A connection request shows a truncated row ("Asked to connect Quantcomm Flood Re… by
  Quantcomm · $0.05 per flood check · $0.10 …  Pending") with no way to decide. The agent's final
  text then repeats the name and price. There should be one decision card, "Connect Quantcomm Flood
  Research?":
  - one meta line ("Quantcomm · up to $0.10 per request");
  - the agent's reason, one line, expandable;
  - Approve / Deny (the dashboard embed).

  The card stays actionable while the approval is pending, even after the agent's run ended.
  Once decided, it collapses to one event line ("Connected Quantcomm Flood Research · you · 2m
  ago").
- C4. Result cards (flood research, analyst view, products, cart, order, receipts) need a key-fact
  header line, 2–4 lines, and one action. The long tails (sources, notes, all banks, evidence) move
  behind "Details". The paid footer is one muted meta line ("Paid $0.05 · tx 0x4e42…"), not a band.
- C5. The "Try" chips are neutral pills. The attack chip keeps a small warning icon but not a red fill.

### Dashboard (`apps/dashboard`)
- D1. The approval card states the cap three times: in the pricing line, in the "Pay up to $0.10 per
  request" bullet, and in "Price cap: Up to $0.10 per payment". Say it once ("Up to $0.10 per
  request"). Permissions become one muted line. The reason is one quoted line, clamped to 2 lines.
- D2. "Waiting on you" appears four times: the sidebar badge, a header stat, the section title, and an
  activity row tag ("Waiting on you · decide above"). Keep the sidebar badge and the section only.
- D3. Activity rows use colored sentences (amber, green), name the agent twice (avatar, sentence,
  meta), and carry a green "✓ On Capital One statement" badge on every row. Rewrite each as one
  Linear activity line: avatar, "**researcher** paid **Quantcomm Flood Research** · 5h ago", and the
  amount right-aligned. Bank state is a small icon with a tooltip, and failures get words plus Retry.
- D4. Agent rows show the balance twice (the "Capital One ••7665 $20.00" chip and "$20.00"). Show one
  balance. The bank becomes muted meta ("Capital One ••7665"), and services become a small icon stack.
- D5. Sheets (bank, agent, add money, new agent, add Shopify, service) follow the same rules: one
  header, grouped rows, one primary action, no repeated explanations.

### Small pages
- P1. Directory (:4060 `/`): turn the big cards with long descriptions, bullets and URLs into a list.
  Each row has an icon, the name, "provider · category" and the price on the right, plus a one-line
  summary. Details open on click (or a `<details>`).
- P2. Bounty board (`packages/agent-work` HTML) and merchant index: same tokens and density, rows
  instead of hero cards. **Keep the poisoned bounty's full text visible**, because it is the attack
  demo.
- P3. Explorer (mock facilitator), and the Shopify and Quantcomm bridge pages if they have HTML: same
  tokens, list layout.
