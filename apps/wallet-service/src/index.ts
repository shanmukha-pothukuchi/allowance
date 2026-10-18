import { ensureOwnerKey, loadConfig } from "@allowance/shared";
import { createApp } from "./app.js";

export { createApp } from "./app.js";
export type { AppDeps, WalletApp } from "./app.js";
export type { Bank, BankOptions } from "./bank.js";
export { Store, createAgentOffline, openStore, issueToken } from "./store.js";

const LOG = "[wallet-service]";

const isMain = process.argv[1] && /wallet-service[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  // Owner endpoints are never open: generate a key if none is configured (setup normally does this).
  if (!config.ownerApiKey) config.ownerApiKey = ensureOwnerKey(config.dataDir);
  const wallet = createApp(config);
  const server = wallet.app.listen(config.walletServicePort, () => {
    console.log(
      `${LOG} listening on http://localhost:${config.walletServicePort} (chain=${config.chainMode}, facilitator=${config.facilitatorUrl}, agents=${wallet.store.state.agents.length})`,
    );
    // Capital One (§16): links the owner's checking and starts the queue; never blocks startup.
    if (wallet.bank.enabled) console.log(`${LOG} Capital One (Nessie sandbox) enabled`);
    wallet.bank.start();
    void wallet.seedBalances().catch((err: Error) => console.warn(`${LOG} seeding failed: ${err.message}`));
  });
  const shutdown = () => {
    console.log(`${LOG} shutting down`);
    wallet.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
