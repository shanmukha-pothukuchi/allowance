import { ensureOwnerKey, loadConfig } from "@allowance/shared";
import { createDirectoryApp } from "./app.js";

export { createDirectoryApp, catalogPage, escapeHtml, type DirectoryApp, type DirectoryConfig, type DirectoryDeps } from "./app.js";
export { buildCatalog, searchCatalog, withoutDocs, type CatalogConfig } from "./catalog.js";
export { shopifyManifest, shopifyServiceId, parseShopifyCap, asShopifyStore, SHOPIFY_DEFAULT_MAX_PRICE } from "./shopify.js";

const LOG = "[directory]";

const isMain = process.argv[1] && /directory[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  // Adding/removing stores is an owner power: never leave it open (setup normally creates the key).
  if (!config.ownerApiKey) config.ownerApiKey = ensureOwnerKey(config.dataDir);
  const app = createDirectoryApp(config);
  const server = app.listen(config.directoryPort, () => {
    const added = app.locals.extras.list().length;
    console.log(
      `${LOG} service directory on http://localhost:${config.directoryPort} (${app.locals.services.length} services${added ? `, ${added} Shopify store${added === 1 ? "" : "s"}` : ""}; bridge ${config.shopifyBridgeUrl})`,
    );
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
