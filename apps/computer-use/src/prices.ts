/**
 * What the computer charges (docs/ARCHITECTURE.md §19.3). No flat rates: time is bought in one-minute
 * blocks (1–5 per payment) and every action and read is its own small payment. Each price and its
 * 402 description live here, so the paywall, the free index, the docs and the receipts agree.
 */

/** Dollars per one-minute block of lease. */
export const PER_MINUTE = "0.02";
/** Most minutes one payment can buy. */
export const MAX_MINUTES_PER_PAYMENT = 5;

export const ACTION_KINDS = ["navigate", "click", "type", "key", "scroll", "select", "hover", "back", "forward", "reload"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Dollars per action, by kind: what changes the page costs more than a key or a scroll. */
export const ACTION_PRICES: Record<ActionKind, string> = {
  navigate: "0.005",
  click: "0.005",
  type: "0.005",
  select: "0.005",
  key: "0.003",
  scroll: "0.003",
  hover: "0.003",
  back: "0.003",
  forward: "0.003",
  reload: "0.003",
};

export type ReadKind = "snapshot" | "screenshot";
/** Dollars per read: cheaper than an action. */
export const READ_PRICES: Record<ReadKind, string> = { snapshot: "0.002", screenshot: "0.003" };

/** The resource description in each 402, which becomes the receipt and statement line. */
export const SERVICE_NAME = "Computer use";
export const PROVIDER = "Allowance";
export const minutesLabel = (m: number) => `${m} minute${m === 1 ? "" : "s"}`;
export const timeDescription = (m: number) => `${SERVICE_NAME} · ${minutesLabel(m)}`;
export const actionDescription = (k: ActionKind) => `${SERVICE_NAME} · ${k}`;
export const readDescription = (k: ReadKind) => `${SERVICE_NAME} · ${k === "snapshot" ? "text snapshot" : "screenshot"}`;

/** Price of `m` minutes, in dollars (exact: 0.02 has two decimals). */
export function timePrice(m: number): string {
  const cents = Math.round(Number(PER_MINUTE) * 100) * m;
  return (cents / 100).toFixed(2);
}

/** The largest single payment (the directory's maxPrice and the service cap). */
export const MAX_PRICE = timePrice(MAX_MINUTES_PER_PAYMENT);

/** The one-line pricing summary (directory and index). */
export const PRICING = `$${PER_MINUTE} per minute · $${ACTION_PRICES.click} per action · reads from $${READ_PRICES.snapshot}`;

export function isActionKind(k: string): k is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(k);
}
