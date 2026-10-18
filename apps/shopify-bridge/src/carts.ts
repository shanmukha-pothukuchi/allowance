/** 30-minute carts kept in memory. Paid carts are kept a day so a repeat checkout can return the order. */
import type { ShopifyMode, ShopifyStore } from "@allowance/shared";
import type { ShippingAddressInput } from "./orders.js";

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
}

/** What a placed order looks like on the wire (checkout 200, and inside 409 cart_already_paid). */
export interface PlacedOrder {
  status: "placed";
  orderId: string;
  orderName: string;
  adminUrl: string;
  store: ShopifyStore;
  total: string;
  currency: string;
  items: { title: string; variantTitle: string; quantity: number; unitPrice: string; lineTotal: string; image: string | null }[];
  txHash?: string;
  explorerUrl?: string;
}

export interface Cart {
  id: string;
  handle: string;
  mode: ShopifyMode;
  lines: CartLine[];
  subtotal: string;
  shipping: string;
  total: string;
  currency: string;
  createdAt: number;
  expiresAt: number;
  /** Bridge checkout (agent_checkout) or Shopify's checkout link (handoff). */
  checkoutUrl: string;
  email?: string;
  note?: string;
  shippingAddress?: ShippingAddressInput;
  /** open → ordering (payment verified, orderCreate running) → placed. Back to open if orderCreate fails or settlement fails. */
  status: "open" | "ordering" | "placed";
  order?: PlacedOrder;
  /** EIP-3009 nonce of the payment that placed (or is placing) the order: links settle hooks to the cart. */
  paymentNonce?: string;
  payer?: string;
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
    if (c.status === "ordering") return false;
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
