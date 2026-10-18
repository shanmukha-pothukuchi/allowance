import { ensureOwnerKey, loadConfig } from "@allowance/shared";
import { createBrokerageApp } from "./app.js";

export {
  createBrokerageApp,
  CALENDAR_TICKER,
  DISCLAIMER,
  HttpError,
  MAX_ORDER,
  MAX_QUOTES,
  MIN_ORDER,
  PROVIDER,
  SERVICE_NAME,
  type BrokerageApp,
  type BrokerageConfig,
  type BrokerageDeps,
  type OrderView,
  type PortfolioBody,
  type PositionView,
  type Quote,
} from "./app.js";
export { clockSettingsFromEnv, ReplayClock, DEFAULT_DAY_SECONDS, type ClockSettings, type ClockView, type PriceMode } from "./clock.js";
export { createPriceSource, type PriceSource, type History, type Listing, type TickerInfo } from "./prices.js";
export { Book, brokerageFilePath, formatShares, parseShares, type Order, type Position } from "./book.js";
export { loadBrokerageAccount, brokerageKeyPath } from "./wallet.js";

const isMain = process.argv[1] && /brokerage[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  // The owner endpoints (portfolio by address, clock) and the mock float's mint need the owner key.
  if (!config.ownerApiKey) config.ownerApiKey = ensureOwnerKey(config.dataDir);
  const app = createBrokerageApp(config);
  const server = app.listen(config.brokeragePort, () => {
    console.log(`[brokerage] paper brokerage on http://localhost:${config.brokeragePort} (prices from Quantcomm at ${config.quantcommUrl}, GET only)`);
    console.log(`[brokerage]   wallet ${app.locals.payTo} · facilitator ${config.x402FacilitatorUrl} (${config.chainMode} mode)`);
    void app.locals.fund();
    const load = (attempt: number): void => {
      app.locals.ready().catch((err: Error) => {
        if (attempt === 0) console.warn(`[brokerage]   Quantcomm isn't answering yet (${err.message}); prices load when it is (cd ../technica2026 && .venv/bin/python -m quantcomm.web)`);
        setTimeout(() => load(attempt + 1), 5000).unref();
      });
    };
    load(0);
  });
  const shutdown = () => {
    app.locals.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
