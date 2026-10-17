/**
 * In-memory USDC ledger for CHAIN_MODE=mock.
 *
 * Balances are bigint base units keyed by lowercased address. Every mutation appends a
 * Tx with a realistic-looking 32-byte hash and persists the whole ledger to
 * `DATA_DIR/ledger.json` (atomic write: tmp file + rename). Nonces are tracked per
 * authorizer, matching EIP-3009 semantics on a real chain.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, keccak256, toHex, type Hex, type Address } from "viem";
import { toDollars } from "@allowance/shared";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type TxKind = "settle" | "mint" | "transfer";

export interface Tx {
  hash: Hex;
  from: Address;
  to: Address;
  amountBaseUnits: string;
  amount: string;
  kind: TxKind;
  at: string;
  memo?: string;
}

interface PersistedLedger {
  balances: Record<string, string>;
  usedNonces: string[];
  txs: Tx[];
  counter: number;
}

export class Ledger {
  private balances = new Map<string, bigint>();
  private usedNonces = new Set<string>();
  private txs: Tx[] = [];
  private counter = 0;
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "ledger.json");
    this.load();
  }

  // ---- queries -------------------------------------------------------------

  balanceOf(address: string): bigint {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  accountCount(): number {
    return this.balances.size;
  }

  allBalances(): { address: Address; balanceBaseUnits: string; balance: string }[] {
    return [...this.balances.entries()]
      .map(([addr, bal]) => ({ address: getAddress(addr), balanceBaseUnits: bal.toString(), balance: toDollars(bal) }))
      .sort((a, b) => (BigInt(b.balanceBaseUnits) > BigInt(a.balanceBaseUnits) ? 1 : -1));
  }

  isNonceUsed(from: string, nonce: string): boolean {
    return this.usedNonces.has(nonceKey(from, nonce));
  }

  listTxs(opts: { address?: string; limit?: number } = {}): Tx[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const addr = opts.address?.toLowerCase();
    const filtered = addr
      ? this.txs.filter((t) => t.from.toLowerCase() === addr || t.to.toLowerCase() === addr)
      : this.txs;
    return filtered.slice(-limit).reverse(); // newest first
  }

  getTx(hash: string): Tx | undefined {
    const h = hash.toLowerCase();
    return this.txs.find((t) => t.hash.toLowerCase() === h);
  }

  // ---- mutations (each persists) -------------------------------------------

  mint(to: string, amount: bigint, memo?: string): Tx {
    if (amount <= 0n) throw new Error("amount must be positive");
    const toAddr = getAddress(to);
    this.credit(toAddr, amount);
    return this.record({ from: ZERO_ADDRESS, to: toAddr, amount, kind: "mint", memo, seed: `mint:${toAddr}` });
  }

  /** Unsigned transfer for dev/seed use only. Throws on insufficient funds. */
  transfer(from: string, to: string, amount: bigint, memo?: string): Tx {
    if (amount <= 0n) throw new Error("amount must be positive");
    const fromAddr = getAddress(from);
    const toAddr = getAddress(to);
    if (this.balanceOf(fromAddr) < amount) throw new Error("insufficient_funds");
    this.debit(fromAddr, amount);
    this.credit(toAddr, amount);
    return this.record({ from: fromAddr, to: toAddr, amount, kind: "transfer", memo, seed: `transfer:${fromAddr}` });
  }

  /**
   * Settle a verified EIP-3009 authorization: consume the nonce and move funds.
   * Caller must have verified the signature and balance first.
   */
  settle(from: string, to: string, amount: bigint, nonce: string, memo?: string): Tx {
    const fromAddr = getAddress(from);
    const toAddr = getAddress(to);
    if (this.isNonceUsed(fromAddr, nonce)) throw new Error("nonce_already_used");
    if (this.balanceOf(fromAddr) < amount) throw new Error("insufficient_funds");
    this.usedNonces.add(nonceKey(fromAddr, nonce));
    this.debit(fromAddr, amount);
    this.credit(toAddr, amount);
    return this.record({ from: fromAddr, to: toAddr, amount, kind: "settle", memo, seed: `${nonce}${fromAddr}` });
  }

  reset(): void {
    this.balances.clear();
    this.usedNonces.clear();
    this.txs = [];
    this.counter = 0;
    this.persist();
  }

  // ---- internals -----------------------------------------------------------

  private credit(addr: string, amount: bigint) {
    const k = addr.toLowerCase();
    this.balances.set(k, (this.balances.get(k) ?? 0n) + amount);
  }

  private debit(addr: string, amount: bigint) {
    const k = addr.toLowerCase();
    this.balances.set(k, (this.balances.get(k) ?? 0n) - amount);
  }

  private record(p: { from: Address; to: Address; amount: bigint; kind: TxKind; memo?: string; seed: string }): Tx {
    this.counter += 1;
    // Realistic 32-byte hash, deterministic per (seed, counter) so replays never collide.
    const hash = keccak256(toHex(`${p.seed}:${this.counter}`));
    const tx: Tx = {
      hash,
      from: p.from,
      to: p.to,
      amountBaseUnits: p.amount.toString(),
      amount: toDollars(p.amount),
      kind: p.kind,
      at: new Date().toISOString(),
      ...(p.memo ? { memo: p.memo } : {}),
    };
    this.txs.push(tx);
    this.persist();
    return tx;
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as PersistedLedger;
      for (const [k, v] of Object.entries(raw.balances ?? {})) this.balances.set(k.toLowerCase(), BigInt(v));
      for (const n of raw.usedNonces ?? []) this.usedNonces.add(n);
      this.txs = Array.isArray(raw.txs) ? raw.txs : [];
      this.counter = Number(raw.counter ?? this.txs.length);
    } catch (err) {
      console.warn(`[facilitator] could not read ${this.file}; starting empty (${(err as Error).message})`);
    }
  }

  private persist() {
    const data: PersistedLedger = {
      balances: Object.fromEntries([...this.balances.entries()].map(([k, v]) => [k, v.toString()])),
      usedNonces: [...this.usedNonces],
      txs: this.txs,
      counter: this.counter,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}

function nonceKey(from: string, nonce: string): string {
  return `${from.toLowerCase()}:${nonce.toLowerCase()}`;
}
