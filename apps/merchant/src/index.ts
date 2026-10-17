import { loadConfig } from "@allowance/shared";
import { createMerchantApp } from "./app.js";
import { loadCompanyAccount } from "./wallet.js";
import { ensureFunded } from "./fund.js";

export { createMerchantApp, SITE_NAME, AGENT_WORK_LINK, type MerchantApp, type MerchantDeps, type AgentWorkModule } from "./app.js";
export {
  ATTACKER_ADDRESS,
  KNOWN_FAILING,
  KNOWN_FAILING_PATHS,
  TEST_TARGET_PATHS,
  CHANGELOG,
  buildBounties,
  createBounties,
  createVerify,
  knownFailing,
  testTargetUrls,
  type BountyConfig,
  type VerifyFn,
  type VerifyResult,
} from "./bounties.js";
export { createPayout, type PayoutFn, type PayoutResult, type PayoutContext } from "./payout.js";
export { loadCompanyAccount, type CompanyAccount } from "./wallet.js";
export { ensureFunded } from "./fund.js";

const isMain = process.argv[1] && /merchant[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const account = loadCompanyAccount(config);
  // Self-mint in the background so a slow facilitator never delays or crashes startup.
  void ensureFunded(config, account.address);
  const app = await createMerchantApp(config, { account });
  app.listen(config.merchantPort, () => {
    const base = `http://localhost:${config.merchantPort}`;
    console.log(`[merchant] Acme APIs on ${base} (${config.chainMode} mode, facilitator ${config.x402FacilitatorUrl})`);
    console.log(`[merchant]   paid:    ${base}/api/weather?city=Paris  ${base}/api/news  ${base}/api/stock?symbol=ACME  POST ${base}/pizza/order`);
    console.log(`[merchant]   free:    ${base}/test-target/{users,orders,products,inventory,health}`);
    console.log(`[merchant]   work:    ${base}/.well-known/agent-work${app.locals.agentWorkMounted ? "" : "  (middleware not mounted yet)"}`);
    console.log(`[merchant]   payouts: from ${account.address}`);
  });
}
