/**
 * Catalog sources for a store, all mapped to the bridge's product shape (docs/ARCHITECTURE.md §15.1):
 * the store's public, tokenless Storefront API (always asked for US prices with
 * `@inContext(country: US)`), or UCP `search_catalog` (optional fallback for stores whose Storefront
 * API is not public, only with a configured agent profile). Carts are real Shopify carts
 * (`cartCreate`), so totals and the checkout link are Shopify's own.
 */
import { toBaseUnits, toDollars } from "@allowance/shared";
import { ShopifyError } from "./errors.js";
import type { StorefrontClient } from "./storefront.js";
import type { UcpClient } from "./ucp.js";

export type CatalogSource = "storefront" | "ucp";

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
  /** The product page on the storefront. */
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
  url: string;
}

export interface ShopInfo {
  name: string;
  /** Currency US shoppers pay in (presentment currency for the US market). */
  currency: string;
  /** Country the store answered for (`@inContext(country: US)` falls back when it doesn't sell to the US). */
  country?: string;
  /** The storefront's primary domain URL, e.g. "https://www.allbirds.com". */
  storefrontUrl?: string;
  sampleImages: string[];
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

/** Variants per product in list results (keeps the tokenless Storefront query cost low). */
export const LIST_VARIANTS = 10;
/** Variants for a single product. */
export const DETAIL_VARIANTS = 50;
export const DESCRIPTION_MAX = 300;
export const SAMPLE_IMAGES = 4;
/** Shopify CDN resizes on request; product cards and previews never need more. */
const IMAGE = "url(transform: { maxWidth: 640 })";
const SAMPLE_IMAGE = "url(transform: { maxWidth: 480 })";

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

const httpsUrl = (u: unknown): string | null => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

/** The product page: Shopify's `onlineStoreUrl` (on the storefront's own domain) or `{storefront}/products/{handle}`. */
export function productUrl(storefrontUrl: string, handle: string, onlineStoreUrl?: unknown): string {
  return httpsUrl(onlineStoreUrl) ?? `${storefrontUrl.replace(/\/+$/, "")}/products/${encodeURIComponent(handle)}`;
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

// ---- Storefront API (tokenless, US context) ------------------------------------------------------

const SF_PRODUCT_FIELDS = `
  id handle title description onlineStoreUrl availableForSale
  featuredImage { ${IMAGE} }
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

export function storefrontCatalog(sf: StorefrontClient, storefrontUrl: () => string): Catalog {
  let currency: string | undefined;
  const shop = async (): Promise<ShopInfo> => {
    const d = await sf.graphql<{
      shop: { name: string; primaryDomain?: { url?: string } | null; paymentSettings?: { currencyCode?: string } | null };
      localization?: { country?: { isoCode?: string; currency?: { isoCode?: string } | null } | null } | null;
      products?: { nodes?: { featuredImage?: { url?: string } | null }[]; pageInfo?: { hasNextPage?: boolean } };
    }>(
      `query BridgeShop @inContext(country: US) {
        shop { name primaryDomain { url } paymentSettings { currencyCode } }
        localization { country { isoCode currency { isoCode } } }
        products(first: 12, sortKey: BEST_SELLING) { nodes { featuredImage { ${SAMPLE_IMAGE} } } pageInfo { hasNextPage } }
      }`,
    );
    currency = d.localization?.country?.currency?.isoCode ?? d.shop.paymentSettings?.currencyCode ?? "USD";
    const nodes = d.products?.nodes ?? [];
    const images = [...new Set(nodes.map((p) => httpsUrl(p?.featuredImage?.url)).filter((u): u is string => Boolean(u)))].slice(0, SAMPLE_IMAGES);
    const info: ShopInfo = { name: d.shop.name, currency, sampleImages: images };
    if (d.localization?.country?.isoCode) info.country = d.localization.country.isoCode;
    if (d.shop.primaryDomain?.url) info.storefrontUrl = d.shop.primaryDomain.url;
    if (d.products?.pageInfo?.hasNextPage === false) info.productCount = nodes.length;
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
      image: httpsUrl(p.featuredImage?.url),
      url: productUrl(storefrontUrl(), p.handle, p.onlineStoreUrl),
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
        `query BridgeProducts($first: Int!, $query: String, $variants: Int!) @inContext(country: US) { products(first: $first, query: $query) { nodes { ${SF_PRODUCT_FIELDS} } } }`,
        { first: limit, query: terms || null, variants: LIST_VARIANTS },
      );
      return d.products.nodes.map(map);
    },
    async product(handle) {
      if (!PRODUCT_HANDLE_RE.test(handle)) return null;
      const d = await sf.graphql<{ product: SfProduct | null }>(
        `query BridgeProduct($handle: String!, $variants: Int!) @inContext(country: US) { product(handle: $handle) { ${SF_PRODUCT_FIELDS} } }`,
        { handle, variants: DETAIL_VARIANTS },
      );
      return d.product ? map(d.product) : null;
    },
    async variants(ids) {
      const out = new Map<string, VariantDetail>();
      if (!ids.length) return out;
      const d = await sf.graphql<{
        nodes: ({
          id: string;
          title: string;
          availableForSale: boolean;
          price: { amount: string; currencyCode: string };
          image?: { url?: string } | null;
          product?: { title: string; handle: string; onlineStoreUrl?: string | null; featuredImage?: { url?: string } | null };
        } | null)[];
      }>(
        `query BridgeVariants($ids: [ID!]!) @inContext(country: US) { nodes(ids: $ids) { ... on ProductVariant { id title availableForSale price { amount currencyCode } image { ${IMAGE} } product { title handle onlineStoreUrl featuredImage { ${IMAGE} } } } } }`,
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
          image: httpsUrl(v.image?.url) ?? httpsUrl(v.product.featuredImage?.url),
          url: productUrl(storefrontUrl(), v.product.handle, v.product.onlineStoreUrl),
        });
      }
      return out;
    },
  };
}

// ---- Storefront carts ---------------------------------------------------------------------------

export interface ShopifyCartLine {
  variantId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  currency: string;
  title: string;
  variantTitle: string;
  image: string | null;
  url: string;
}

export interface ShopifyCart {
  /** Shopify's cart GID. */
  id: string;
  /** Shopify's own checkout page for this cart. */
  checkoutUrl: string;
  subtotal: string;
  total: string;
  currency: string;
  lines: ShopifyCartLine[];
  /** Shopify's cart warnings (e.g. a quantity was reduced to what's in stock). */
  warnings: string[];
}

interface SfMoney {
  amount: string;
  currencyCode: string;
}

/**
 * Storefront `cartCreate` for a US buyer: a real Shopify cart, with Shopify's prices, totals and
 * checkout link. `userErrors` become a `rejected` ShopifyError with Shopify's message.
 */
export async function createStorefrontCart(
  sf: StorefrontClient,
  storefrontUrl: string,
  input: { lines: { variantId: string; quantity: number }[]; email?: string; note?: string },
): Promise<ShopifyCart> {
  const d = await sf.graphql<{
    cartCreate: {
      cart: {
        id: string;
        checkoutUrl: string;
        cost: { subtotalAmount: SfMoney; totalAmount: SfMoney };
        lines: {
          nodes: {
            quantity: number;
            cost: { amountPerQuantity: SfMoney; totalAmount: SfMoney };
            merchandise: { id?: string; title?: string; image?: { url?: string } | null; product?: { title: string; handle: string; onlineStoreUrl?: string | null; featuredImage?: { url?: string } | null } };
          }[];
        };
      } | null;
      userErrors: { field?: string[] | null; message: string; code?: string | null }[];
      warnings?: { code?: string; message: string }[] | null;
    };
  }>(
    `mutation BridgeCartCreate($input: CartInput!) @inContext(country: US) {
      cartCreate(input: $input) {
        cart {
          id checkoutUrl
          cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
          lines(first: 50) { nodes { quantity cost { amountPerQuantity { amount currencyCode } totalAmount { amount currencyCode } }
            merchandise { ... on ProductVariant { id title image { ${IMAGE} } product { title handle onlineStoreUrl featuredImage { ${IMAGE} } } } } } }
        }
        userErrors { field message code }
        warnings { code message }
      }
    }`,
    {
      input: {
        lines: input.lines.map((l) => ({ merchandiseId: l.variantId, quantity: l.quantity })),
        buyerIdentity: { countryCode: "US", ...(input.email ? { email: input.email } : {}) },
        ...(input.note ? { note: input.note } : {}),
      },
    },
  );
  const errs = d.cartCreate.userErrors ?? [];
  const cart = d.cartCreate.cart;
  if (errs.length || !cart?.checkoutUrl) throw new ShopifyError("rejected", `Shopify refused the cart: ${errs.map((e) => e.message).join("; ") || "no cart returned"}`);
  return {
    id: cart.id,
    checkoutUrl: cart.checkoutUrl,
    subtotal: money(cart.cost.subtotalAmount.amount),
    total: money(cart.cost.totalAmount.amount),
    currency: cart.cost.totalAmount.currencyCode,
    lines: cart.lines.nodes.flatMap((n) => {
      const m = n.merchandise;
      if (!m?.id || !m.product) return [];
      return [
        {
          variantId: m.id,
          quantity: n.quantity,
          unitPrice: money(n.cost.amountPerQuantity.amount),
          lineTotal: money(n.cost.totalAmount.amount),
          currency: n.cost.totalAmount.currencyCode,
          title: cleanTitle(m.product.title),
          variantTitle: cleanTitle(m.title),
          image: httpsUrl(m.image?.url) ?? httpsUrl(m.product.featuredImage?.url),
          url: productUrl(storefrontUrl, m.product.handle, m.product.onlineStoreUrl),
        },
      ];
    }),
    warnings: (d.cartCreate.warnings ?? []).map((w) => w.message).filter(Boolean),
  };
}

/** Shopify cart permalink (`/cart/<variant>:<qty>,…`): works without any API (UCP-only stores). */
export function cartPermalink(storefrontUrl: string, lines: { variantId: string; quantity: number }[]): string {
  const parts = lines.map((l) => `${numericId(l.variantId)}:${l.quantity}`);
  return `${storefrontUrl.replace(/\/+$/, "")}/cart/${parts.join(",")}`;
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

export function ucpCatalog(ucp: UcpClient, fallbackName: string, storefrontUrl: () => string): Catalog {
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
  const imageOf = (media: UcpProduct["media"]) => (media ?? []).map((m) => ((m.type ?? "image") === "image" ? httpsUrl(m.url) : null)).find(Boolean) ?? null;
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
      image: imageOf(p.media),
      url: productUrl(storefrontUrl(), handle, p.url),
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
      const products = await search(undefined, 8);
      const currency = products[0]?.price_range?.min?.currency ?? products[0]?.variants?.[0]?.price?.currency ?? "USD";
      const sampleImages = [...new Set(products.map((p) => imageOf(p.media)).filter((u): u is string => Boolean(u)))].slice(0, SAMPLE_IMAGES);
      return { name: fallbackName, currency, sampleImages };
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
              image: imageOf(v.media) ?? product.image,
              url: product.url,
            });
          }
        }
      }
      return out;
    },
  };
}
