/** Errors shared by the bridge's HTTP layer and its Shopify clients. */

/** An API error the bridge answers with: `{ error: code, message, ...extra }`. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type ShopifyErrorKind =
  /** Storefront API without a token on a password-protected store: "Online Store channel is locked." */
  | "locked"
  /** No such shop (404 from Shopify). */
  | "not_found"
  /** GraphQL `errors` (query problems, throttling that did not clear). */
  | "graphql"
  /** Shopify refused the input (`userErrors`, e.g. a cart it won't create). */
  | "rejected"
  /** Non-2xx HTTP answer that is none of the above (5xx, 402 frozen shop, HTML error pages). */
  | "http"
  /** Could not reach Shopify (DNS, TLS, timeout). */
  | "network";

export class ShopifyError extends Error {
  constructor(
    public kind: ShopifyErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

export function isShopifyError(err: unknown, kind?: ShopifyErrorKind): err is ShopifyError {
  return err instanceof ShopifyError && (kind === undefined || err.kind === kind);
}
