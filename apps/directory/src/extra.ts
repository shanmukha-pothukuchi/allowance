/**
 * Dynamic directory entries (docs/ARCHITECTURE.md §15.2): Shopify stores the owner added, persisted in
 * `DATA_DIR/directory-extra.json`. We store the store facts and the cap, and rebuild the manifest on
 * load, so a new bridge URL or better docs apply to stores added earlier. Without a dataDir (tests,
 * embedded use) entries live in memory only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShopifyStore } from "@allowance/shared";
import { asShopifyStore, parseShopifyCap, shopifyServiceId } from "./shopify.js";

export interface ShopifyEntry {
  store: ShopifyStore;
  /** Owner's per-order cap, dollars. */
  maxPrice: string;
  addedAt: string;
}

interface ExtraFile {
  version: 1;
  shopify: ShopifyEntry[];
}

const LOG = "[directory]";

export class DirectoryExtras {
  private entries: ShopifyEntry[] = [];
  readonly file?: string;

  constructor(dataDir?: string) {
    this.file = dataDir ? join(dataDir, "directory-extra.json") : undefined;
    this.entries = this.load();
  }

  list(): readonly ShopifyEntry[] {
    return this.entries;
  }

  find(id: string): ShopifyEntry | undefined {
    return this.entries.find((e) => shopifyServiceId(e.store.handle) === id);
  }

  add(entry: ShopifyEntry): void {
    this.entries.push(entry);
    this.save();
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => shopifyServiceId(e.store.handle) !== id);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  private load(): ShopifyEntry[] {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ExtraFile>;
      const out: ShopifyEntry[] = [];
      for (const e of Array.isArray(raw.shopify) ? raw.shopify : []) {
        const store = asShopifyStore(e?.store);
        if (!store || out.some((x) => x.store.handle === store.handle)) continue;
        let maxPrice: string;
        try {
          maxPrice = parseShopifyCap(e.maxPrice);
        } catch {
          continue;
        }
        out.push({ store, maxPrice, addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString() });
      }
      return out;
    } catch (err) {
      // Never take the directory (and so the demo) down over a bad file: start without the extras.
      console.warn(`${LOG} could not read ${this.file} (${(err as Error).message}); starting without added stores`);
      return [];
    }
  }

  private save(): void {
    if (!this.file) return;
    const body: ExtraFile = { version: 1, shopify: this.entries };
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}
