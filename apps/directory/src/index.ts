import { loadConfig } from "@allowance/shared";
import { createDirectoryApp } from "./app.js";

export { createDirectoryApp, catalogPage, escapeHtml, type DirectoryApp, type DirectoryConfig } from "./app.js";
export { buildCatalog, searchCatalog, withoutDocs, type CatalogConfig } from "./catalog.js";

const LOG = "[directory]";

const isMain = process.argv[1] && /directory[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const app = createDirectoryApp(config);
  const server = app.listen(config.directoryPort, () => {
    console.log(`${LOG} service directory on http://localhost:${config.directoryPort} (${app.locals.services.length} services)`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
