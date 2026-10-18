/**
 * Admin API order mutations used by agent checkout (docs/ARCHITECTURE.md §15.1):
 * `orderCreate` (financial status PAID, one SALE transaction through "Allowance USDC (x402)"),
 * `orderUpdate` (put the settlement tx hash in the note) and `orderCancel` (settlement failed after
 * the order was created). Needs `write_orders`.
 */
import { ShopifyError } from "./errors.js";
import type { AdminClient } from "./admin.js";

export const GATEWAY = "Allowance USDC (x402)";
export const ORDER_TAGS = ["allowance", "x402"];

export interface ShippingAddressInput {
  name?: string;
  address1?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
}

export interface CreateOrderInput {
  currency: string;
  total: string;
  lines: { variantId: string; quantity: number; unitPrice: string }[];
  note: string;
  email?: string;
  shippingAddress?: ShippingAddressInput;
  /** Mark the order and transaction as test (USDC here is testnet or mock money). */
  test: boolean;
}

export interface CreatedOrder {
  id: string;
  name: string;
  legacyResourceId?: string;
}

const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  america: "US",
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  australia: "AU",
  germany: "DE",
  france: "FR",
  india: "IN",
  mexico: "MX",
};

/** Contract address → Admin `MailingAddressInput` (codes only; deprecated free-text fields avoided). */
export function mailingAddress(a: ShippingAddressInput | undefined): Record<string, string> | undefined {
  if (!a) return undefined;
  const out: Record<string, string> = {};
  if (a.name) {
    const parts = a.name.trim().split(/\s+/);
    if (parts.length > 1) {
      out.firstName = parts.slice(0, -1).join(" ");
      out.lastName = parts[parts.length - 1];
    } else out.lastName = parts[0];
  }
  if (a.address1) out.address1 = a.address1;
  if (a.city) out.city = a.city;
  if (a.zip) out.zip = a.zip;
  if (a.country) {
    const c = a.country.trim();
    const code = /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : COUNTRY_NAMES[c.toLowerCase()];
    if (code) out.countryCode = code;
  }
  if (a.province && /^[A-Za-z0-9]{1,3}$/.test(a.province.trim())) out.provinceCode = a.province.trim().toUpperCase();
  return Object.keys(out).length ? out : undefined;
}

export async function createPaidOrder(admin: AdminClient, input: CreateOrderInput): Promise<CreatedOrder> {
  const money = (amount: string) => ({ shopMoney: { amount, currencyCode: input.currency } });
  const order: Record<string, unknown> = {
    currency: input.currency,
    financialStatus: "PAID",
    lineItems: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, priceSet: money(l.unitPrice) })),
    transactions: [{ kind: "SALE", status: "SUCCESS", gateway: GATEWAY, amountSet: money(input.total), test: input.test }],
    note: input.note,
    tags: ORDER_TAGS,
    test: input.test,
  };
  if (input.email) order.email = input.email;
  const address = mailingAddress(input.shippingAddress);
  if (address) order.shippingAddress = address;
  const d = await admin.graphql<{
    orderCreate: { order: { id: string; name: string; legacyResourceId?: string } | null; userErrors: { field?: string[] | null; message: string }[] };
  }>(
    `mutation BridgeOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name legacyResourceId }
        userErrors { field message }
      }
    }`,
    { order, options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false } },
  );
  const errs = d.orderCreate.userErrors ?? [];
  if (errs.length || !d.orderCreate.order) {
    const msg = errs.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; ") || "no order returned";
    throw new ShopifyError("graphql", `orderCreate failed: ${msg}`);
  }
  return d.orderCreate.order;
}

export async function updateOrderNote(admin: AdminClient, orderId: string, note: string): Promise<void> {
  const d = await admin.graphql<{ orderUpdate: { order: { id: string } | null; userErrors: { message: string }[] } }>(
    `mutation BridgeOrderUpdate($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
    { input: { id: orderId, note } },
  );
  const errs = d.orderUpdate.userErrors ?? [];
  if (errs.length) throw new ShopifyError("graphql", `orderUpdate failed: ${errs.map((e) => e.message).join("; ")}`);
}

export async function cancelOrder(admin: AdminClient, orderId: string, staffNote: string): Promise<void> {
  const d = await admin.graphql<{ orderCancel: { orderCancelUserErrors?: { message: string }[]; userErrors?: { message: string }[] } }>(
    `mutation BridgeOrderCancel($orderId: ID!, $staffNote: String) {
      orderCancel(orderId: $orderId, reason: OTHER, restock: true, notifyCustomer: false, staffNote: $staffNote) {
        orderCancelUserErrors { field message }
      }
    }`,
    { orderId, staffNote: staffNote.slice(0, 255) },
  );
  const errs = d.orderCancel.orderCancelUserErrors ?? d.orderCancel.userErrors ?? [];
  if (errs.length) throw new ShopifyError("graphql", `orderCancel failed: ${errs.map((e) => e.message).join("; ")}`);
}

/** "gid://shopify/Order/123" → https://admin.shopify.com/store/<handle>/orders/123 */
export function adminOrderUrl(handle: string, orderId: string, legacyResourceId?: string): string {
  const id = legacyResourceId ?? /(\d+)$/.exec(orderId)?.[1] ?? "";
  return `https://admin.shopify.com/store/${handle}/orders/${id}`;
}
