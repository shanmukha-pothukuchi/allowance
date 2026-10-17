/** npm run reset — wipe DATA_DIR (keys, tokens, ledger, receipts) and run setup again. */
import { rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "@allowance/shared";

const config = loadConfig();
const force = process.argv.includes("--force");

// Resetting the ledger under running services leaves them with stale in-memory state (and the
// merchant's company wallet at $0), so refuse unless forced.
const up = await fetch(`${config.walletServiceUrl}/v1/health`).then((r) => r.ok).catch(() => false);
if (up && !force) {
  console.error("[reset] services are running. Stop `npm run dev` first, then run `npm run reset` (or pass --force).");
  process.exit(1);
}
if (existsSync(config.dataDir)) {
  rmSync(config.dataDir, { recursive: true, force: true });
  console.log(`[reset] removed ${config.dataDir}`);
}
// If services are running, ask them to drop in-memory state too (best effort).
for (const url of [`${config.facilitatorUrl}/admin/reset`, `${config.walletServiceUrl}/v1/reset`]) {
  try {
    await fetch(url, { method: "POST" });
    console.log(`[reset] ${url} ok`);
  } catch {
    /* not running */
  }
}
const r = spawnSync(process.execPath, [resolve(config.repoRoot, "node_modules/tsx/dist/cli.mjs"), resolve(config.repoRoot, "apps/agents/src/setup.ts")], {
  stdio: "inherit",
});
process.exit(r.status ?? 0);
