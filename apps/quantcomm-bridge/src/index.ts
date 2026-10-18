import { loadConfig } from "@allowance/shared";
import { createQuantcommBridgeApp } from "./app.js";

export { createQuantcommBridgeApp, PRICES, SERVICE_NAME, PROVIDER, type QuantcommBridgeApp, type QuantcommBridgeConfig, type QuantcommBridgeDeps, type AlertsBody, type FloodBody } from "./app.js";
export { createQuantcommClient, CACHE_TTL_MS, type QuantcommClient } from "./upstream.js";
export { CAPITAL_ONE_NOTE, DISCLAIMER, SOURCE, STALE_VIEW_NOTE, SYNTHETIC_NOTE, type ViewBody } from "./compact.js";
export { loadEarningsAccount, earningsKeyPath } from "./wallet.js";

const isMain = process.argv[1] && /quantcomm-bridge[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const app = createQuantcommBridgeApp(config);
  const server = app.listen(config.quantcommBridgePort, () => {
    console.log(`[quantcomm] bridge on http://localhost:${config.quantcommBridgePort} (Quantcomm at ${config.quantcommUrl}; read-only, cached 60 s)`);
    console.log(`[quantcomm]   earnings wallet ${app.locals.payTo} · facilitator ${config.x402FacilitatorUrl} (${config.chainMode} mode)`);
    app.locals.upstream.markets().then(
      (m) => console.log(`[quantcomm]   Quantcomm is up: ${m.universe.length} companies, prices as of ${m.asOf}`),
      (err: Error) => console.warn(`[quantcomm]   Quantcomm isn't answering yet (${err.message}); start it with: cd ../technica2026 && .venv/bin/python -m quantcomm.web`),
    );
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
