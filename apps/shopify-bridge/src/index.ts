import { ensureOwnerKey, loadConfig } from "@allowance/shared";
import { createBridgeApp } from "./app.js";

export { createBridgeApp, normalizeVariantId, parseCartBody, type BridgeApp, type BridgeConfig, type BridgeDeps } from "./app.js";
export { createAdminClient, type AdminClient } from "./admin.js";
export { createStorefrontClient, type StorefrontClient } from "./storefront.js";
export { createUcpClient, myshopifyDomainFromUcp } from "./ucp.js";
export { parseStoreInput, normalizeAdminShop, StoreRegistry, publicStore, type StoreRecord } from "./stores.js";
export { GATEWAY, ORDER_TAGS } from "./orders.js";
export type { BridgeProduct, BridgeVariant, CatalogSource } from "./catalog.js";
export type { Cart, CartLine, PlacedOrder } from "./carts.js";
export { loadBridgeAccount, bridgeKeyPath } from "./wallet.js";

const isMain = process.argv[1] && /shopify-bridge[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  if (!config.ownerApiKey) config.ownerApiKey = ensureOwnerKey(config.dataDir);
  const app = createBridgeApp(config);
  const server = app.listen(config.shopifyBridgePort, () => {
    const n = app.locals.registry.size;
    console.log(
      `[shopify] bridge on http://localhost:${config.shopifyBridgePort} (${n} store${n === 1 ? "" : "s"}, admin: ${app.locals.adminShop && app.locals.admin ? app.locals.adminShop : "not configured"})`,
    );
    console.log(`[shopify]   payTo ${app.locals.payTo} · facilitator ${config.x402FacilitatorUrl} (${config.chainMode} mode)`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
