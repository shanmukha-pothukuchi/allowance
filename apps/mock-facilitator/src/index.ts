import { loadConfig } from "@allowance/shared";
import { createFacilitatorApp } from "./app.js";

export { createFacilitatorApp, type FacilitatorApp, type FacilitatorAppOptions, MOCK_FACILITATOR_SIGNER } from "./app.js";
export { Ledger, type Tx, type TxKind, ZERO_ADDRESS } from "./ledger.js";
export { LedgerExactEvmFacilitator, AUTHORIZATION_TYPES } from "./scheme.js";

// Only listen when run directly (`tsx apps/mock-facilitator/src/index.ts`), not when imported.
const isMain = process.argv[1] && /mock-facilitator[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  if (config.chainMode !== "mock") {
    console.warn(`[facilitator] CHAIN_MODE=${config.chainMode}: the mock facilitator is only used in mock mode, starting anyway`);
  }
  const app = createFacilitatorApp(config);
  app.listen(config.facilitatorPort, () => {
    console.log(
      `[facilitator] mock facilitator on http://localhost:${config.facilitatorPort} (ledger: ${app.locals.ledger.accountCount()} accounts)`,
    );
    console.log(`[facilitator] explorer: http://localhost:${config.facilitatorPort}/explorer`);
  });
}
