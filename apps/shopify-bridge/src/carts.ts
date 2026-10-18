/**
 * 30-minute carts kept in memory, each backed by a real Shopify cart. Paid carts are kept a day so a
 * repeat checkout can return the same confirmation. Also the simulated Allowance Card confirmation
 * (docs/ARCHITECTURE.md §15.1).
 */
import { randomInt } from "node:crypto";
import { formatUsd, toBaseUnits } from "@allowance/shared";

export const CART_TTL_MS = 30 * 60_000;
export const PAID_CART_TTL_MS = 24 * 60 * 60_000;
export const MAX_LINES = 20;
export const MAX_QUANTITY = 20;

export interface CartLine {
  variantId: string;
  title: string;
  variantTitle: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  image: string | null;
  /** The product page on the storefront. */
  url: string;
}

/** What a placed order looks like on the wire (checkout 200, and inside 409 cart_already_paid). */
export interface OrderConfirmation {
  status: "placed";
  /** Card issuing and Shopify's agent card checkout are not wired: the store did not receive this order. */
  simulated: true;
  /** Allowance reference, "ALW-XXXX-XXXX" (not a Shopify order number). */
  reference: string;
  store: { name: string; storefrontUrl: string };
  items: CartLine[];
  total: string;
  currency: string;
  card: { brand: "Allowance Card"; last4: string };
  paidAt: string;
  /** One sentence on what would happen for real. */
  explanation: string;
  /** The USDC settlement (set once the payment settles). */
  txHash?: string;
  explorerUrl?: string;
}

export interface Cart {
  id: string;
  handle: string;
  lines: CartLine[];
  subtotal: string;
  total: string;
  currency: string;
  createdAt: number;
  expiresAt: number;
  /** The bridge's x402 checkout. */
  checkoutUrl: string;
  /** Shopify's own checkout page for the real cart (or a cart permalink for UCP-only stores). */
  shopifyCheckoutUrl: string;
  /** Shopify's cart GID, when a real cart was created. */
  shopifyCartId?: string;
  email?: string;
  note?: string;
  /** Last 4 of the single-use Allowance Card for this cart: random, stable for the cart's life. */
  cardLast4: string;
  /** open → settling (payment verified, confirmation issued, settlement running) → placed. Back to open if settlement fails. */
  status: "open" | "settling" | "placed";
  confirmation?: OrderConfirmation;
  /** EIP-3009 nonce of the payment that placed (or is placing) the order: links settle hooks to the cart. */
  paymentNonce?: string;
  payer?: string;
}

/** No 0/O/1/I: references get read aloud and typed. */
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newReference(): string {
  const part = () => Array.from({ length: 4 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join("");
  return `ALW-${part()}-${part()}`;
}

export function newCardLast4(): string {
  return String(randomInt(10_000)).padStart(4, "0");
}

/** What would happen for real, in one sentence. */
export function simulatedExplanation(store: { name: string; cardCheckout: boolean }, total: string): string {
  const amount = formatUsd(toBaseUnits(total));
  return store.cardCheckout
    ? `For a real order, Allowance would issue a single-use card for ${amount} and pay ${store.name} through Shopify's agent card checkout; card issuing isn't wired yet, so ${store.name} did not receive this order.`
    : `For a real order, Allowance would issue a single-use card for ${amount} and pay ${store.name} at Shopify checkout (this store doesn't advertise card checkout for agents yet); card issuing isn't wired, so ${store.name} did not receive this order.`;
}

export class CartBook {
  private carts = new Map<string, Cart>();
  private byNonce = new Map<string, string>();

  constructor(private now: () => number = Date.now) {}

  add(cart: Cart): void {
    this.purge();
    this.carts.set(cart.id, cart);
  }

  /** The cart if it exists and has not expired (paid carts stay readable for a day). */
  get(id: string): Cart | undefined {
    const c = this.carts.get(id);
    if (!c) return undefined;
    if (this.expired(c)) {
      this.drop(c);
      return undefined;
    }
    return c;
  }

  linkNonce(cart: Cart, nonce: string): void {
    cart.paymentNonce = nonce;
    this.byNonce.set(nonce.toLowerCase(), cart.id);
  }

  byPaymentNonce(nonce: string | undefined): Cart | undefined {
    if (!nonce) return undefined;
    const id = this.byNonce.get(nonce.toLowerCase());
    const cart = id ? this.carts.get(id) : undefined;
    return cart && cart.paymentNonce?.toLowerCase() === nonce.toLowerCase() ? cart : undefined;
  }

  unlinkNonce(cart: Cart): void {
    if (cart.paymentNonce) this.byNonce.delete(cart.paymentNonce.toLowerCase());
    cart.paymentNonce = undefined;
  }

  get size(): number {
    return this.carts.size;
  }

  private expired(c: Cart): boolean {
    const t = this.now();
    if (c.status === "placed") return t > c.createdAt + PAID_CART_TTL_MS;
    if (c.status === "settling") return false;
    return t > c.expiresAt;
  }

  private drop(c: Cart): void {
    this.carts.delete(c.id);
    if (c.paymentNonce) this.byNonce.delete(c.paymentNonce.toLowerCase());
  }

  private purge(): void {
    for (const c of this.carts.values()) if (this.expired(c)) this.drop(c);
  }
}
