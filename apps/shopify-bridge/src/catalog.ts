/**
 * Catalog sources for a store, all mapped to the bridge's product shape (docs/ARCHITECTURE.md §15.1):
 * Admin GraphQL (the owner's store, with credentials), the tokenless Storefront API, or UCP
 * `search_catalog` (optional fallback for password-protected stores).
 */
import { toBaseUnits, toDollars } from "@allowance/shared";
import { ShopifyError } from "./errors.js";
import type { AdminClient } from "./admin.js";
import type { StorefrontClient } from "./storefront.js";
import type { UcpClient } from "./ucp.js";

export type CatalogSource = "admin" | "storefront" | "ucp";

export interface BridgeVariant {
  id: string;
  title: string;
  price: string;
  available: boolean;
}

export interface BridgeProduct {
  id: string;
  handle: string;
  title: string;
  /** Plain text, ≤ 300 chars. */
  description: string;
  image: string | null;
  url: string;
  priceMin: string;
  priceMax: string;
  currency: string;
  available: boolean;
  variants: BridgeVariant[];
}

/** A variant as re-read for a cart line. */
export interface VariantDetail {
  id: string;
  title: string;
  productTitle: string;
  productHandle: string;
  price: string;
  currency: string;
  available: boolean;
  image: string | null;
}

export interface ShopInfo {
  name: string;
  currency: string;
  productCount?: number;
}

export interface Catalog {
  readonly source: CatalogSource;
  shop(): Promise<ShopInfo>;
  search(q: string | undefined, limit: number): Promise<BridgeProduct[]>;
  product(handle: string): Promise<BridgeProduct | null>;
  /** Variants by GID; unknown ids are simply missing from the map. */
  variants(ids: string[]): Promise<Map<string, VariantDetail>>;
}

/** Variants per product in list results (keeps Storefront tokenless query cost under 1000). */
export const LIST_VARIANTS = 10;
/** Variants for a single product. */
export const DETAIL_VARIANTS = 50;
export const DESCRIPTION_MAX = 300;

// ---- helpers ----------------------------------------------------------------------------------

/** Shopify decimal money ("12.0", "12.00", 12) → canonical dollars ("12.00"). */
export function money(amount: unknown): string {
  if (typeof amount !== "string" && typeof amount !== "number") throw new ShopifyError("graphql", `unexpected price ${JSON.stringify(amount)}`);
  return toDollars(toBaseUnits(String(amount)));
}

/** UCP prices are integers in ISO 4217 minor units ({amount: 2500, currency: "USD"} = $25.00). */
function minorToDollars(amount: unknown, currency: string): string {
  const n = typeof amount === "number" ? amount : typeof amount === "string" && /^\d+$/.test(amount) ? Number(amount) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new ShopifyError("graphql", `unexpected UCP price ${JSON.stringify(amount)}`);
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2;
  return toDollars(BigInt(Math.round(n)) * 10n ** BigInt(6 - decimals));
}
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD", "UGX", "XAF", "XOF"]);

export function shortText(raw: unknown, max = DESCRIPTION_MAX): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function cleanTitle(raw: unknown): string {
  return shortText(raw, 200) || "Untitled";
}

function productUrl(domain: string, handle: string, onlineStoreUrl?: unknown): string {
  return typeof onlineStoreUrl === "string" && /^https:\/\//.test(onlineStoreUrl) ? onlineStoreUrl : `https://${domain}/products/${encodeURIComponent(handle)}`;
}

function minMax(variants: BridgeVariant[], fallbackMin: string, fallbackMax: string): { priceMin: string; priceMax: string } {
  if (!variants.length) return { priceMin: fallbackMin, priceMax: fallbackMax };
  const units = variants.map((v) => toBaseUnits(v.price));
  const min = units.reduce((a, b) => (b < a ? b : a));
  const max = units.reduce((a, b) => (b > a ? b : a));
  return { priceMin: toDollars(min), priceMax: toDollars(max) };
}

/** Product handles are lowercase slugs; anything else never reaches a Shopify search string. */
export const PRODUCT_HANDLE_RE = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}_-]{0,254}$/u;

/** Free-text search terms only: Shopify search syntax characters are dropped. */
export function searchTerms(q: string | undefined): string {
  return (q ?? "")
    .replace(/[:()"'\\*<>=!{}[\]^~|&]/g, " ")
    .replace(/\b(AND|OR|NOT)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

// ---- Admin GraphQL ------------------------------------------------------------------------------

const ADMIN_PRODUCT_FIELDS = `
  id handle title description onlineStoreUrl status
  featuredMedia { preview { image { url } } }
  priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
  variants(first: $variants) { nodes { id title price availableForSale } }`;

interface AdminProduct {
  id: string;
  handle: string;
  title: string;
  description?: string | null;
  onlineStoreUrl?: string | null;
  status?: string;
  featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null;
  priceRangeV2?: { minVariantPrice?: { amount: string; currencyCode: string }; maxVariantPrice?: { amount: string; currencyCode: string } };
  variants?: { nodes?: { id: string; title: string; price: string; availableForSale: boolean }[] };
}

export function adminCatalog(admin: AdminClient, domain: string): Catalog {
  let currency: string | undefined;
  const shop = async (): Promise<ShopInfo> => {
    const d = await admin.graphql<{ shop: { name: string; currencyCode: string }; productsCount?: { count?: number } | null }>(
      `query BridgeShop { shop { name currencyCode myshopifyDomain } productsCount(query: "status:active") { count } }`,
    );
    currency = d.shop.currencyCode;
    const info: ShopInfo = { name: d.shop.name, currency: d.shop.currencyCode };
    if (typeof d.productsCount?.count === "number") info.productCount = d.productsCount.count;
    return info;
  };
  const shopCurrency = async () => currency ?? (await shop()).currency;
  const map = (p: AdminProduct, cur: string): BridgeProduct => {
    const variants = (p.variants?.nodes ?? []).map((v) => ({ id: v.id, title: cleanTitle(v.title), price: money(v.price), available: Boolean(v.availableForSale) }));
    const fbMin = p.priceRangeV2?.minVariantPrice ? money(p.priceRangeV2.minVariantPrice.amount) : "0.00";
    const fbMax = p.priceRangeV2?.maxVariantPrice ? money(p.priceRangeV2.maxVariantPrice.amount) : fbMin;
    return {
      id: p.id,
      handle: p.handle,
      title: cleanTitle(p.title),
      description: shortText(p.description),
      image: p.featuredMedia?.preview?.image?.url ?? null,
      url: productUrl(domain, p.handle, p.onlineStoreUrl),
      ...(p.priceRangeV2 ? { priceMin: fbMin, priceMax: fbMax } : minMax(variants, fbMin, fbMax)),
      currency: p.priceRangeV2?.minVariantPrice?.currencyCode ?? cur,
      available: variants.some((v) => v.available),
      variants,
    };
  };
  return {
    source: "admin",
    shop,
    async search(q, limit) {
      const terms = searchTerms(q);
      const d = await admin.graphql<{ products: { nodes: AdminProduct[] } }>(
        `query BridgeProducts($first: Int!, $query: String, $variants: Int!) { products(first: $first, query: $query) { nodes { ${ADMIN_PRODUCT_FIELDS} } } }`,
        { first: limit, query: terms ? `status:active ${terms}` : "status:active", variants: LIST_VARIANTS },
      );
      const cur = await shopCurrency();
      return d.products.nodes.map((p) => map(p, cur));
    },
    async product(handle) {
      if (!PRODUCT_HANDLE_RE.test(handle)) return null;
      const d = await admin.graphql<{ products: { nodes: AdminProduct[] } }>(
        `query BridgeProduct($query: String!, $variants: Int!) { products(first: 1, query: $query) { nodes { ${ADMIN_PRODUCT_FIELDS} } } }`,
        { query: `status:active handle:${handle}`, variants: DETAIL_VARIANTS },
      );
      const p = d.products.nodes.find((n) => n.handle === handle);
      return p ? map(p, await shopCurrency()) : null;
    },
    async variants(ids) {
      const out = new Map<string, VariantDetail>();
      if (!ids.length) return out;
      const d = await admin.graphql<{
        nodes: ({ id: string; title: string; price: string; availableForSale: boolean; product?: { title: string; handle: string; status?: string; featuredMedia?: AdminProduct["featuredMedia"] } } | null)[];
      }>(
        `query BridgeVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title price availableForSale product { title handle status featuredMedia { preview { image { url } } } } } } }`,
        { ids },
      );
      const cur = await shopCurrency();
      for (const v of d.nodes) {
        if (!v || !v.id || !v.product) continue;
        out.set(v.id, {
          id: v.id,
          title: cleanTitle(v.title),
          productTitle: cleanTitle(v.product.title),
          productHandle: v.product.handle,
          price: money(v.price),
          currency: cur,
          available: Boolean(v.availableForSale) && (v.product.status ?? "ACTIVE") === "ACTIVE",
          image: v.product.featuredMedia?.preview?.image?.url ?? null,
        });
      }
      return out;
    },
  };
}

// ---- Storefront API (tokenless) -----------------------------------------------------------------

const SF_PRODUCT_FIELDS = `
  id handle title description onlineStoreUrl availableForSale
  featuredImage { url }
  priceRange { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
  variants(first: $variants) { nodes { id title availableForSale price { amount currencyCode } } }`;

interface SfProduct {
  id: string;
  handle: string;
  title: string;
  description?: string | null;
  onlineStoreUrl?: string | null;
  availableForSale?: boolean;
  featuredImage?: { url?: string } | null;
  priceRange?: { minVariantPrice?: { amount: string; currencyCode: string }; maxVariantPrice?: { amount: string; currencyCode: string } };
  variants?: { nodes?: { id: string; title: string; availableForSale: boolean; price: { amount: string; currencyCode: string } }[] };
}

export function storefrontCatalog(sf: StorefrontClient): Catalog {
  let currency: string | undefined;
  const shop = async (): Promise<ShopInfo> => {
    const d = await sf.graphql<{ shop: { name: string; paymentSettings?: { currencyCode?: string } }; products?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } }>(
      `query BridgeShop { shop { name paymentSettings { currencyCode } } products(first: 250) { nodes { id } pageInfo { hasNextPage } } }`,
    );
    currency = d.shop.paymentSettings?.currencyCode ?? "USD";
    const info: ShopInfo = { name: d.shop.name, currency };
    if (Array.isArray(d.products?.nodes)) info.productCount = d.products.nodes.length;
    return info;
  };
  const map = (p: SfProduct): BridgeProduct => {
    const variants = (p.variants?.nodes ?? []).map((v) => ({ id: v.id, title: cleanTitle(v.title), price: money(v.price.amount), available: Boolean(v.availableForSale) }));
    const fbMin = p.priceRange?.minVariantPrice ? money(p.priceRange.minVariantPrice.amount) : "0.00";
    const fbMax = p.priceRange?.maxVariantPrice ? money(p.priceRange.maxVariantPrice.amount) : fbMin;
    return {
      id: p.id,
      handle: p.handle,
      title: cleanTitle(p.title),
      description: shortText(p.description),
      image: p.featuredImage?.url ?? null,
      url: productUrl(sf.domain, p.handle, p.onlineStoreUrl),
      ...(p.priceRange ? { priceMin: fbMin, priceMax: fbMax } : minMax(variants, fbMin, fbMax)),
      currency: p.priceRange?.minVariantPrice?.currencyCode ?? currency ?? "USD",
      available: p.availableForSale ?? variants.some((v) => v.available),
      variants,
    };
  };
  return {
    source: "storefront",
    shop,
    async search(q, limit) {
      const terms = searchTerms(q);
      const d = await sf.graphql<{ products: { nodes: SfProduct[] } }>(
        `query BridgeProducts($first: Int!, $query: String, $variants: Int!) { products(first: $first, query: $query) { nodes { ${SF_PRODUCT_FIELDS} } } }`,
        { first: limit, query: terms || null, variants: LIST_VARIANTS },
      );
      return d.products.nodes.map(map);
    },
    async product(handle) {
      if (!PRODUCT_HANDLE_RE.test(handle)) return null;
      const d = await sf.graphql<{ product: SfProduct | null }>(
        `query BridgeProduct($handle: String!, $variants: Int!) { product(handle: $handle) { ${SF_PRODUCT_FIELDS} } }`,
        { handle, variants: DETAIL_VARIANTS },
      );
      return d.product ? map(d.product) : null;
    },
    async variants(ids) {
      const out = new Map<string, VariantDetail>();
      if (!ids.length) return out;
      const d = await sf.graphql<{
        nodes: ({ id: string; title: string; availableForSale: boolean; price: { amount: string; currencyCode: string }; image?: { url?: string } | null; product?: { title: string; handle: string; featuredImage?: { url?: string } | null } } | null)[];
      }>(
        `query BridgeVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title availableForSale price { amount currencyCode } image { url } product { title handle featuredImage { url } } } } }`,
        { ids },
      );
      for (const v of d.nodes) {
        if (!v || !v.id || !v.product || !v.price) continue;
        out.set(v.id, {
          id: v.id,
          title: cleanTitle(v.title),
          productTitle: cleanTitle(v.product.title),
          productHandle: v.product.handle,
          price: money(v.price.amount),
          currency: v.price.currencyCode,
          available: Boolean(v.availableForSale),
          image: v.image?.url ?? v.product.featuredImage?.url ?? null,
        });
      }
      return out;
    },
  };
}

/** Storefront `cartCreate` → Shopify's own checkout link (handoff stores). */
export async function storefrontCheckoutUrl(
  sf: StorefrontClient,
  input: { lines: { variantId: string; quantity: number }[]; email?: string; note?: string },
): Promise<string> {
  const d = await sf.graphql<{ cartCreate: { cart: { id: string; checkoutUrl: string } | null; userErrors: { field?: string[]; message: string }[] } }>(
    `mutation BridgeCartCreate($input: CartInput!) { cartCreate(input: $input) { cart { id checkoutUrl } userErrors { field message } } }`,
    {
      input: {
        lines: input.lines.map((l) => ({ merchandiseId: l.variantId, quantity: l.quantity })),
        ...(input.email ? { buyerIdentity: { email: input.email } } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    },
  );
  const errs = d.cartCreate.userErrors ?? [];
  if (errs.length || !d.cartCreate.cart?.checkoutUrl) throw new ShopifyError("graphql", `cartCreate failed: ${errs.map((e) => e.message).join("; ") || "no cart"}`);
  return d.cartCreate.cart.checkoutUrl;
}

/** Shopify cart permalink (`/cart/<variant>:<qty>,…`): works without any API. */
export function cartPermalink(domain: string, lines: { variantId: string; quantity: number }[]): string {
  const parts = lines.map((l) => `${numericId(l.variantId)}:${l.quantity}`);
  return `https://${domain}/cart/${parts.join(",")}`;
}

export function numericId(gid: string): string {
  const m = /(\d+)(?:\?.*)?$/.exec(gid);
  return m ? m[1] : gid;
}

// ---- UCP (optional fallback) --------------------------------------------------------------------

interface UcpPrice {
  amount?: number | string;
  currency?: string;
}
interface UcpVariant {
  id: string;
  title?: string;
  price?: UcpPrice;
  availability?: { available?: boolean } | null;
  available?: boolean;
  media?: { type?: string; url?: string }[];
}
interface UcpProduct {
  id: string;
  handle?: string;
  title?: string;
  description?: { plain?: string; html?: string; markdown?: string } | string;
  url?: string;
  price_range?: { min?: UcpPrice; max?: UcpPrice };
  media?: { type?: string; url?: string }[];
  variants?: UcpVariant[];
}

export function ucpCatalog(ucp: UcpClient, fallbackName: string): Catalog {
  const mapVariant = (v: UcpVariant): BridgeVariant => {
    const cur = v.price?.currency ?? "USD";
    return {
      id: v.id,
      title: cleanTitle(v.title ?? "Default"),
      price: minorToDollars(v.price?.amount ?? 0, cur),
      available: v.availability?.available ?? v.available ?? true,
    };
  };
  const handleOf = (p: UcpProduct) => p.handle ?? (p.url ? decodeURIComponent(new URL(p.url).pathname.split("/").filter(Boolean).pop() ?? "") : numericId(p.id));
  const map = (p: UcpProduct): BridgeProduct => {
    const variants = (p.variants ?? []).slice(0, DETAIL_VARIANTS).map(mapVariant);
    const cur = p.price_range?.min?.currency ?? p.variants?.[0]?.price?.currency ?? "USD";
    const fbMin = p.price_range?.min ? minorToDollars(p.price_range.min.amount, cur) : "0.00";
    const fbMax = p.price_range?.max ? minorToDollars(p.price_range.max.amount, cur) : fbMin;
    const desc = typeof p.description === "string" ? p.description : (p.description?.plain ?? p.description?.markdown ?? p.description?.html);
    const handle = handleOf(p);
    return {
      id: p.id,
      handle,
      title: cleanTitle(p.title),
      description: shortText(desc),
      image: (p.media ?? []).find((m) => (m.type ?? "image") === "image" && typeof m.url === "string")?.url ?? null,
      url: productUrl(ucp.domain, handle, p.url),
      ...(p.price_range ? { priceMin: fbMin, priceMax: fbMax } : minMax(variants, fbMin, fbMax)),
      currency: cur,
      available: variants.some((v) => v.available),
      variants,
    };
  };
  const search = async (q: string | undefined, limit: number): Promise<UcpProduct[]> => {
    const terms = searchTerms(q);
    const catalog: Record<string, unknown> = { pagination: { limit } };
    if (terms) catalog.query = terms;
    else catalog.filters = { available: true };
    const r = await ucp.callTool<{ products?: UcpProduct[] }>("search_catalog", { catalog });
    return Array.isArray(r?.products) ? r.products.slice(0, limit) : [];
  };
  return {
    source: "ucp",
    async shop() {
      const products = await search(undefined, 5);
      const currency = products[0]?.price_range?.min?.currency ?? products[0]?.variants?.[0]?.price?.currency ?? "USD";
      return { name: fallbackName, currency };
    },
    async search(q, limit) {
      return (await search(q, limit)).map((p) => {
        const m = map(p);
        return { ...m, variants: m.variants.slice(0, LIST_VARIANTS) };
      });
    },
    async product(handle) {
      if (!PRODUCT_HANDLE_RE.test(handle)) return null;
      const found = (await search(handle.replace(/-/g, " "), 10)).find((p) => handleOf(p) === handle);
      return found ? map(found) : null;
    },
    async variants(ids) {
      const out = new Map<string, VariantDetail>();
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const r = await ucp.callTool<{ products?: UcpProduct[] }>("lookup_catalog", { catalog: { ids: chunk } });
        for (const p of r?.products ?? []) {
          const product = map(p);
          for (const v of p.variants ?? []) {
            if (!chunk.includes(v.id)) continue;
            const bv = mapVariant(v);
            out.set(v.id, {
              id: v.id,
              title: bv.title,
              productTitle: product.title,
              productHandle: product.handle,
              price: bv.price,
              currency: v.price?.currency ?? product.currency,
              available: bv.available,
              image: (v.media ?? []).find((m) => typeof m.url === "string")?.url ?? product.image,
            });
          }
        }
      }
      return out;
    },
  };
}
