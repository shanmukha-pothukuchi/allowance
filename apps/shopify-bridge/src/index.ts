import { ensureOwnerKey, loadConfig } from "@allowance/shared";
import { createBridgeApp } from "./app.js";

export { createBridgeApp, normalizeVariantId, parseCartBody, PRIVATE_CATALOG, type BridgeApp, type BridgeConfig, type BridgeDeps } from "./app.js";
export { createStorefrontClient, type StorefrontClient } from "./storefront.js";
export { createUcpClient, fetchUcpProfile, fetchShopMeta, CARD_HANDLER } from "./ucp.js";
export { parseStoreInput, StoreRegistry, publicStore, type StoreRecord } from "./stores.js";
export type { BridgeProduct, BridgeVariant, CatalogSource } from "./catalog.js";
export type { Cart, CartLine, OrderConfirmation } from "./carts.js";
export { loadBridgeAccount, bridgeKeyPath } from "./wallet.js";

const isMain = process.argv[1] && /shopify-bridge[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  if (!config.ownerApiKey) config.ownerApiKey = ensureOwnerKey(config.dataDir);
  const app = createBridgeApp(config);
  const server = app.listen(config.shopifyBridgePort, () => {
    const n = app.locals.registry.size;
    console.log(
      `[shopify] bridge on http://localhost:${config.shopifyBridgePort} (${n} store${n === 1 ? "" : "s"}; any public Shopify store; UCP catalog fallback ${config.shopify.ucpAgentProfileUrl ? "on" : "off"})`,
    );
    console.log(`[shopify]   Allowance Card treasury ${app.locals.payTo} · facilitator ${config.x402FacilitatorUrl} (${config.chainMode} mode)`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
