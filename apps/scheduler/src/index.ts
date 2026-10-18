/**
 * Scheduler: http://localhost:4100 (§20.3)
 *
 * Wakes chat agents without the owner typing anything: reminders an agent sets for itself, price
 * watches on the paper brokerage, and the owner's take-profit / stop-loss / cash-out rules. A firing
 * is a message to the agent's chat (`source: "scheduler"`, X-Scheduler-Token); the agent then acts
 * through its own tools, so the wallet's policy still decides every payment.
 */
import { resolve } from "node:path";
import { ensureOwnerKey, loadConfig } from "@allowance/shared";
import { createSchedulerApp } from "./app.js";
import { httpChat } from "./chat.js";
import { Scheduler } from "./engine.js";
import { httpMarket } from "./market.js";
import { ScheduleStore } from "./store.js";
import { ensureSchedulerToken } from "./token.js";
import { httpWallet } from "./wallet.js";

export { createSchedulerApp, type SchedulerAppOptions } from "./app.js";
export { Scheduler, SchedulerError, parseCondition, evalPrice, evalPortfolio, type ScheduleInput, type RuleInput, type ScheduleView, type SchedulerOptions } from "./engine.js";
export { httpChat, type ChatClient, type DeliverResult } from "./chat.js";
export { httpMarket, ownerPortfolioReader, parsePortfolio, MarketError, type MarketData, type Portfolio, type PortfolioReader, type Quote, type QuotesResult } from "./market.js";
export { httpWallet, WalletUnavailableError, type WalletAuth, type AgentIdentity } from "./wallet.js";
export { ScheduleStore } from "./store.js";
export { ensureSchedulerToken, readSchedulerToken, schedulerTokenPath } from "./token.js";
export * from "./types.js";

const LOG = "[scheduler]";
const isMain = process.argv[1] && /scheduler[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const ownerApiKey = config.ownerApiKey || ensureOwnerKey(config.dataDir);
  const token = ensureSchedulerToken(config.dataDir);
  const scheduler = new Scheduler({
    store: new ScheduleStore(resolve(config.dataDir, "schedules.json")),
    chat: httpChat({ agentChatUrl: config.agentChatUrl, token }),
    market: httpMarket({ brokerageUrl: config.brokerageUrl, ownerApiKey }),
  });
  const app = createSchedulerApp({ scheduler, ownerApiKey, wallet: httpWallet({ walletServiceUrl: config.walletServiceUrl, ownerApiKey }) });
  const host = process.env.SCHEDULER_HOST || "127.0.0.1";
  const server = app.listen(config.schedulerPort, host, () => {
    const n = scheduler.list().length;
    console.log(`${LOG} on http://localhost:${config.schedulerPort} (${n} active schedule${n === 1 ? "" : "s"}${scheduler.paused ? ", PAUSED by the owner" : ""}; wakes agents at ${config.agentChatUrl}; prices from ${config.brokerageUrl})`);
  });
  scheduler.start(1000);
  const shutdown = () => {
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
