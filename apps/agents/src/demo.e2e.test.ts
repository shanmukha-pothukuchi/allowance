/**
 * End to end: real facilitator, merchant, directory and wallet-service in this process on port 0,
 * then the real `setup.ts` and `demo.ts --auto-approve` as child processes pointed at them.
 * Proves the scripted demo still works with connected services (act 4 asks for Acme Pizza first).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "@allowance/shared";
import type { AppConfig } from "@allowance/shared";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createMerchantApp } from "../../merchant/src/app.js";
import { loadCompanyAccount } from "../../merchant/src/wallet.js";
import { ensureFunded } from "../../merchant/src/fund.js";
import { createDirectoryApp } from "../../directory/src/app.js";
import { createApp } from "../../wallet-service/src/app.js";
import type { WalletApp } from "../../wallet-service/src/app.js";
import { buildSeeds } from "./lib/seeds.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const OWNER_KEY = "ok_e2e_test_key";
const repoRoot = resolve(import.meta.dirname, "../../..");
const tsx = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");

let dataDir: string;
let config: AppConfig;
let wallet: WalletApp | undefined;
const servers: Server[] = [];
const handlers: Record<string, Handler | undefined> = {};

/** A port-0 server whose handler can be attached later (503 until then). */
async function slot(name: string): Promise<string> {
  const srv = createServer((req, res) => {
    const h = handlers[name];
    if (h) return h(req, res);
    res.statusCode = 503;
    res.end("not ready");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

function childEnv(): NodeJS.ProcessEnv {
  const port = (u: string) => new URL(u).port;
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CHAIN_MODE: "mock",
    DATA_DIR: dataDir,
    OWNER_API_KEY: OWNER_KEY,
    FACILITATOR_URL: config.facilitatorUrl,
    FACILITATOR_PORT: port(config.facilitatorUrl),
    MERCHANT_URL: config.merchantUrl,
    MERCHANT_PORT: port(config.merchantUrl),
    WALLET_SERVICE_URL: config.walletServiceUrl,
    WALLET_SERVICE_PORT: port(config.walletServiceUrl),
    DIRECTORY_URL: config.directoryUrl,
    DIRECTORY_PORT: port(config.directoryUrl),
    TELEGRAM_BOT_TOKEN: "",
    DEMO_FAST: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
}

function run(script: string, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [tsx, resolve(repoRoot, script), ...args], { cwd: repoRoot, env: childEnv() });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolveRun({ code, out }));
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "allowance-e2e-"));
  for (const level of ["log", "warn", "info"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  const [facilitatorUrl, merchantUrl, directoryUrl, walletServiceUrl] = await Promise.all(["facilitator", "merchant", "directory", "wallet"].map(slot));
  config = {
    ...loadConfig(),
    chainMode: "mock",
    dataDir,
    ownerApiKey: OWNER_KEY,
    merchantPrivateKey: undefined,
    telegramBotToken: undefined,
    facilitatorUrl,
    x402FacilitatorUrl: facilitatorUrl,
    merchantUrl,
    directoryUrl,
    walletServiceUrl,
  };
  handlers.facilitator = createFacilitatorApp(config, { quiet: true }) as unknown as Handler;
  handlers.directory = createDirectoryApp(config) as unknown as Handler;
  const account = loadCompanyAccount(config);
  await ensureFunded(config, account.address, { log: () => {} });
  handlers.merchant = (await createMerchantApp(config, { account, quiet: true })) as unknown as Handler;
}, 30_000);

afterAll(async () => {
  wallet?.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("scripted demo with connected services", () => {
  it("setup (offline path) gives every agent a closed allowlist and its default services", async () => {
    const setup = await run("apps/agents/src/setup.ts");
    expect(setup.code, setup.out).toBe(0);
    expect(setup.out).toContain("claude_desktop_config.json");
    expect(setup.out).toContain("[acme-weather, acme-news, acme-stocks]");

    wallet = createApp(config);
    handlers.wallet = wallet.app as unknown as Handler;
    await wallet.seedBalances({ retryMs: 5000 });
    const agents = wallet.store.state.agents;
    for (const seed of buildSeeds()) {
      const a = agents.find((x) => x.name === seed.name)!;
      expect(a.policy.allowlist, seed.name).toEqual({ addresses: [], origins: [] });
      expect(a.services.map((s) => s.id), seed.name).toEqual(seed.services);
      // Acme services live on the merchant; Quantcomm, the brokerage and the Computer on their own services.
      for (const s of a.services) if (s.id.startsWith("acme-")) expect(s.baseUrl.startsWith(config.merchantUrl), s.id).toBe(true);
    }
  }, 60_000);

  it("runs all four acts with --auto-approve: shopper asks to connect Acme Pizza, then orders", async () => {
    const demo = await run("apps/agents/src/demo.ts", ["--auto-approve"]);
    const out = demo.out;
    expect(demo.code, out).toBe(0);
    expect(out).toContain("Demo complete");
    // Act 1: three paid, one turned away.
    expect(out).toContain("3 of 4 agents paid");
    // Act 2: researcher pays its connected services.
    expect(out).toMatch(/Spent today: \$0\.30/);
    // Act 3: still blocked and frozen.
    expect(out).toContain("WALLET REFUSED");
    expect(out).toMatch(/frozen:\s+true/);
    // Act 4: connect, then pay.
    expect(out).toContain("auto-approving connect Acme Pizza for shopper");
    expect(out).toContain("auto-approving $18.50 for shopper");
    expect(out).toMatch(/order ord_\w+ placed/);

    const shopper = wallet!.store.agentByName("shopper")!;
    expect(shopper.services).toEqual([expect.objectContaining({ id: "acme-pizza", connectedBy: "approval" })]);
    expect(wallet!.store.agentByName("naive-worker")!.policy.frozen).toBe(true);
    expect(wallet!.store.agentByName("researcher")!.policy.frozen).toBe(false);
    const events = wallet!.store.state.events.map((e) => e.type);
    expect(events).toContain("service.requested");
    expect(events).toContain("service.connected");
    expect(wallet!.store.state.receipts.some((r) => r.agentName === "shopper" && r.kind === "spend" && r.status === "settled" && r.amount === "18.50")).toBe(true);
  }, 90_000);
});
