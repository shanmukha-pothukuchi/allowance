/**
 * The brokerage's book (docs/ARCHITECTURE.md §20.1): positions per agent wallet address and every
 * order, persisted in `DATA_DIR/brokerage.json` with atomic writes.
 *
 * All arithmetic is in integers:
 * - money in USDC base units (1e-6 dollars), like the rest of Allowance;
 * - shares in micro-shares (1e-6 shares), so fractional shares are exact;
 * - prices in base units per share (a close of 201.74 is 201_740_000).
 * Buys are whole cents; sell proceeds are rounded down to whole cents, so every amount that moves
 * USDC (and every earning an agent reports) is a plain dollar string.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { toDollars } from "@allowance/shared";
import type { ClockSnapshot } from "./clock.js";

export const MICRO = 1_000_000n;
const CENT = 10_000n;
/** Orders kept in the file (newest); older ones are dropped. */
const MAX_ORDERS = 5000;

export interface Position {
  ticker: string;
  sharesMicro: string;
  /** Cost basis of the shares still held, base units. */
  costUnits: string;
  openedAt: string;
  updatedAt: string;
}

export interface Account {
  address: Address;
  positions: Record<string, Position>;
  /** Realized P/L over all sells, base units (signed). */
  realizedUnits: string;
  boughtUnits: string;
  soldUnits: string;
}

export interface Order {
  id: string;
  side: "buy" | "sell";
  address: Address;
  ticker: string;
  sharesMicro: string;
  /** Base units per share. */
  priceUnits: string;
  /** Buy: the amount paid. Sell: the proceeds paid out. Base units. */
  amountUnits: string;
  /** Sell only: the cost basis of the shares sold, and the P/L. */
  costUnits?: string;
  realizedUnits?: string;
  clockDate: string;
  at: string;
  status: "filled" | "failed";
  /** Buy: the agent's x402 settlement. Sell: the payout to the agent. */
  txHash?: Hex;
  error?: string;
}

export interface BrokerageFile {
  version: 1;
  clock?: ClockSnapshot;
  accounts: Record<string, Account>;
  orders: Order[];
}

export function brokerageFilePath(dataDir: string): string {
  return join(dataDir, "brokerage.json");
}

export class Book {
  readonly file: string;
  state: BrokerageFile;

  constructor(dataDir: string, log: (m: string) => void = () => {}) {
    this.file = brokerageFilePath(dataDir);
    this.state = { version: 1, accounts: {}, orders: [] };
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BrokerageFile>;
        this.state = {
          version: 1,
          ...(raw.clock ? { clock: raw.clock } : {}),
          accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {},
          orders: Array.isArray(raw.orders) ? raw.orders : [],
        };
        log(`book: ${Object.keys(this.state.accounts).length} account(s), ${this.state.orders.length} order(s) from ${this.file}`);
      } catch (err) {
        // Never overwrite a book we could not read: it holds agents' positions.
        throw new Error(`could not read ${this.file} (${(err as Error).message}); fix or remove it`);
      }
    }
  }

  save(): void {
    if (this.state.orders.length > MAX_ORDERS) this.state.orders.splice(0, this.state.orders.length - MAX_ORDERS);
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  account(address: string): Account | undefined {
    return this.state.accounts[getAddress(address)];
  }

  accountOrNew(address: string): Account {
    const a = getAddress(address);
    return (this.state.accounts[a] ??= { address: a, positions: {}, realizedUnits: "0", boughtUnits: "0", soldUnits: "0" });
  }

  /** Add shares bought for `costUnits`. */
  addShares(address: string, ticker: string, sharesMicro: bigint, costUnits: bigint, at: string): Position {
    const acct = this.accountOrNew(address);
    const p = (acct.positions[ticker] ??= { ticker, sharesMicro: "0", costUnits: "0", openedAt: at, updatedAt: at });
    p.sharesMicro = (BigInt(p.sharesMicro) + sharesMicro).toString();
    p.costUnits = (BigInt(p.costUnits) + costUnits).toString();
    p.updatedAt = at;
    return p;
  }

  /** Take shares out of a position (a sell, before its payout). Removes the position when it reaches zero. */
  removeShares(address: string, ticker: string, sharesMicro: bigint, costUnits: bigint, at: string): void {
    const acct = this.accountOrNew(address);
    const p = acct.positions[ticker];
    if (!p) throw new Error(`no ${ticker} position`);
    const left = BigInt(p.sharesMicro) - sharesMicro;
    const cost = BigInt(p.costUnits) - costUnits;
    if (left < 0n || cost < 0n) throw new Error(`${ticker} position would go negative`);
    if (left === 0n) delete acct.positions[ticker];
    else Object.assign(p, { sharesMicro: left.toString(), costUnits: cost.toString(), updatedAt: at });
  }

  record(order: Order): void {
    this.state.orders.push(order);
  }

  ordersOf(address: string, limit: number): Order[] {
    const a = getAddress(address);
    const out: Order[] = [];
    for (let i = this.state.orders.length - 1; i >= 0 && out.length < limit; i--) if (this.state.orders[i].address === a) out.push(this.state.orders[i]);
    return out;
  }
}

// ---- math -------------------------------------------------------------------------------------------

/** A close in dollars → base units per share. */
export function priceUnitsOf(close: number): bigint {
  return BigInt(Math.round(close * 1e6));
}

/** How many micro-shares `amountUnits` buys at `priceUnits` (rounded down). */
export function sharesFor(amountUnits: bigint, priceUnits: bigint): bigint {
  return (amountUnits * MICRO) / priceUnits;
}

/** What `sharesMicro` is worth at `priceUnits`, base units (rounded down). */
export function valueOf(sharesMicro: bigint, priceUnits: bigint): bigint {
  return (sharesMicro * priceUnits) / MICRO;
}

/** Rounded down to whole cents (sell proceeds). */
export function floorCents(units: bigint): bigint {
  return units - (units % CENT);
}

/** Rounded half away from zero to cents, as a dollar string: for display. */
export function cents(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const r = ((abs + CENT / 2n) / CENT) * CENT;
  return toDollars(neg && r !== 0n ? -r : r);
}

/** 495687n → "0.495687", 3_200_000n → "3.2", 3_000_000n → "3". */
export function formatShares(micro: bigint): string {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** "1.5" | 1.5 → 1_500_000n; throws on anything but a positive amount with at most 6 decimals. */
export function parseShares(raw: unknown): bigint {
  const s = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error("shares must be a positive number with at most 6 decimals, or \"all\"");
  const micro = BigInt(m[1]) * MICRO + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (micro <= 0n) throw new Error("shares must be more than 0");
  return micro;
}

/** (a - b) / b in percent, 2 decimals (0 when b is 0). */
export function pctChange(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number(((a - b) * 1_000_000n) / b) / 10_000;
}

/** Two decimals; never -0. */
export const round2 = (n: number) => Math.round(n * 100) / 100 || 0;
