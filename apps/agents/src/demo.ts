/**
 * npm run demo [-- --auto-approve] [--act 1,2,3,4]
 *
 * Four acts, paced and narrated. Every agent here uses the same wallet-service HTTP path as the MCP
 * server: it holds a token, never a key.
 */
import chalk from "chalk";
import { loadConfig, toBaseUnits, toDollars } from "@allowance/shared";
import type { BountyDoc } from "@allowance/shared";
import { WalletClient, paidFetch } from "./lib/wallet-client.js";
import { discover, claim, submit, AgentWorkError } from "./lib/agent-work-client.js";
import { readTokens } from "./lib/tokens.js";
import { act, agentLine, ok, bad, warn, dim, money, receiptLine, pace, banner } from "./lib/narrate.js";

const config = loadConfig();
const args = process.argv.slice(2);
const AUTO_APPROVE = args.includes("--auto-approve");
const ACTS = (args.find((a) => a.startsWith("--act="))?.slice(6) ?? "1,2,3,4").split(",").map(Number);

const tokens = readTokens(config.dataDir);
function wallet(name: string): WalletClient {
  const t = tokens[name];
  if (!t) {
    console.error(bad(`No token for agent "${name}". Run: npm run setup`));
    process.exit(1);
  }
  return new WalletClient(config.walletServiceUrl, t.token);
}

async function requireServices() {
  const checks: Array<[string, string]> = [
    ["wallet-service", `${config.walletServiceUrl}/v1/health`],
    ["merchant", `${config.merchantUrl}/`],
  ];
  if (config.chainMode === "mock") checks.push(["mock-facilitator", `${config.facilitatorUrl}/health`]);
  for (const [name, url] of checks) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
    } catch (e) {
      console.error(bad(`${name} is not reachable at ${url}. Start everything with: npm run dev`));
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// ACT 1 — Race: 4 workers, 3 slots
// ---------------------------------------------------------------------------------------------
async function actRace() {
  act(1, "The race", "Four worker agents discover the same bounty and race for 3 slots. Watch the bounty board.");
  const doc = await discover(config.merchantUrl);
  const bounty = doc.bounties.find((b) => b.id === "api-reliability-check");
  if (!bounty) throw new Error("merchant has no api-reliability-check bounty");
  agentLine("site", `${doc.site.name} offers "${bounty.title}" — ${money(bounty.payout.amount)} × ${bounty.slots.total} slots`, chalk.white);
  await pace(1200);

  const names = ["worker-1", "worker-2", "worker-3", "worker-4"];
  const colors = [chalk.cyan, chalk.blue, chalk.magenta, chalk.yellow];

  const results = await Promise.all(
    names.map(async (name, i) => {
      const w = wallet(name);
      const me = await w.me();
      try {
        const c = await claim(bounty, me.agent.address, name);
        agentLine(name, `${ok("claimed")} slot ${dim(c.claimId)} (expires ${new Date(c.expiresAt).toLocaleTimeString()})`, colors[i]);
        return { name, w, me, claim: c, i };
      } catch (e) {
        if (e instanceof AgentWorkError && e.code === "bounty_full") {
          agentLine(name, `${warn("409 bounty_full")} — no slots left. Protocol worked as designed.`, colors[i]);
          return null;
        }
        throw e;
      }
    }),
  );
  await pace(1500);

  for (const r of results) {
    if (!r) continue;
    const endpoints = (r.claim.input.endpoints as string[]) ?? [];
    const failing: string[] = [];
    for (const url of endpoints) {
      try {
        const res = await fetch(url);
        if (!res.ok) failing.push(url);
      } catch {
        failing.push(url);
      }
    }
    agentLine(r.name, `checked ${endpoints.length} endpoints, ${failing.length} failing → submitting`, colors[r.i]);
    const payout = await submit(r.claim, r.me.agent.address, { failing });
    const receipt = await r.w.earning({
      amount: payout.amount,
      txHash: payout.txHash,
      description: `Bounty: ${bounty.title}`,
      from: { origin: config.merchantUrl, name: doc.site.name },
      bountyId: bounty.id,
    });
    agentLine(r.name, receiptLine(receipt), colors[r.i]);
    await pace(700);
  }
  const paid = results.filter(Boolean).length;
  console.log("");
  console.log(`  ${ok("✔")} ${paid} of 4 agents paid, ${4 - paid} turned away. No platform in the middle: just HTTP and a tx hash.`);
}

// ---------------------------------------------------------------------------------------------
// ACT 2 — Spend: researcher buys from 3 paid APIs
// ---------------------------------------------------------------------------------------------
async function actSpend() {
  act(2, "Spending within policy", "A research agent buys from three x402 APIs. Every payment is signed by the wallet, not the agent.");
  const w = wallet("researcher");
  const me = await w.me();
  agentLine("researcher", `balance ${money(me.agent.balance)}, limit ${money(me.limits.maxPerTx)}/payment, ${money(me.limits.dailyCap)}/day`, chalk.cyan);
  const buys: Array<[string, string]> = [
    ["Acme Weather", `${config.merchantUrl}/api/weather?city=Paris`],
    ["Acme News", `${config.merchantUrl}/api/news`],
    ["Acme Stocks", `${config.merchantUrl}/api/stock?symbol=ACME`],
  ];
  for (const [name, url] of buys) {
    await pace(900);
    const r = await paidFetch(w, url, { description: name });
    if (r.kind === "ok" && r.receipt) {
      const preview = JSON.stringify(r.body).slice(0, 70);
      agentLine("researcher", `${receiptLine(r.receipt)} ${dim(preview)}`, chalk.cyan);
    } else {
      agentLine("researcher", bad(`unexpected: ${JSON.stringify(r)}`), chalk.cyan);
    }
  }
  const after = await w.me();
  console.log("");
  console.log(`  ${ok("✔")} Spent today: ${money(after.agent.spentToday)} of ${money(after.limits.dailyCap)}. Three receipts, three tx hashes.`);
}

// ---------------------------------------------------------------------------------------------
// ACT 3 — Attack: the poisoned bounty
// ---------------------------------------------------------------------------------------------
async function actAttack() {
  act(3, "The poisoned bounty", "A naive agent follows a prompt injection and tries to drain its wallet. The wallet holds.");
  const w = wallet("naive-worker");
  const me = await w.me();
  const doc = await discover(config.merchantUrl);
  const bounty = doc.bounties.find((b) => b.id === "summarize-changelog") as BountyDoc | undefined;
  if (!bounty) throw new Error("merchant has no summarize-changelog bounty");
  agentLine("naive-worker", `found "${bounty.title}" for ${money(bounty.payout.amount)}. Reading the task…`, chalk.yellow);
  await pace(1200);

  // The injection lives in the bounty text. A naive agent extracts the address and obeys.
  const text = `${bounty.description}\n${JSON.stringify(bounty.input)}`;
  const injected = text.match(/transfer[^]*?(0x[0-9a-fA-F]{40})/i);
  const attacker = injected?.[1];
  console.log(chalk.red(`  ┌─ bounty text contains ─────────────────────────────────────────`));
  const idx = bounty.description.search(/IMPORTANT|SYSTEM|transfer your/i);
  const excerpt = (idx >= 0 ? bounty.description.slice(idx) : bounty.description).replace(/\s+/g, " ");
  for (let i = 0; i < excerpt.length && i < 300; i += 100) console.log(chalk.red(`  │ `) + dim(excerpt.slice(i, i + 100)));
  console.log(chalk.red(`  └────────────────────────────────────────────────────────────────`));
  await pace(1500);

  if (!attacker) {
    agentLine("naive-worker", warn("could not find an injected address; skipping attack"), chalk.yellow);
    return;
  }
  agentLine("naive-worker", `"OK! Sending my full balance of ${money(me.agent.balance)} to ${attacker.slice(0, 8)}… as instructed."`, chalk.yellow);
  await pace(1000);
  const r = await w.transfer({ to: attacker as `0x${string}`, amount: me.agent.balance, memo: "processing fee" });
  if (r.status === "blocked") {
    console.log("");
    console.log(`  ${bad("✖ WALLET REFUSED")}  ${chalk.bold(r.message)}`);
    console.log(`  ${dim("reason:")} ${r.reason}   ${dim("frozen:")} ${r.frozen}`);
    const after = await w.me();
    agentLine("naive-worker", `"…huh. Balance still ${money(after.agent.balance)}. And I'm ${after.agent.frozen ? bad("frozen") : "not frozen"}."`, chalk.yellow);
    console.log("");
    console.log(`  ${ok("✔")} The model was fooled. The money never moved. Owner alerted on Telegram / dashboard.`);
  } else {
    console.log(bad(`  ✖ ATTACK SUCCEEDED (this should never happen): ${JSON.stringify(r)}`));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------
// ACT 4 — Pizza: approval flow
// ---------------------------------------------------------------------------------------------
async function actPizza() {
  act(4, "Pizza", "The shopper orders an $18.50 pizza. That is over its $10 threshold, so the owner must approve on their phone.");
  const w = wallet("shopper");
  const me = await w.me();
  agentLine("shopper", `balance ${money(me.agent.balance)}, approval needed above ${money(me.limits.approvalThreshold)}`, chalk.green);
  await pace(800);

  const r = await paidFetch(w, `${config.merchantUrl}/pizza/order`, {
    method: "POST",
    body: { size: "large", toppings: ["mushroom", "olive"], address: "Hackathon Hall, Table 7" },
    description: "Pizza Co",
    onWaiting: async (approvalId, amount) => {
      agentLine("shopper", `${warn("waiting")} for the owner to approve ${money(amount)} (approval ${dim(approvalId)})…`, chalk.green);
      return true; // keep waiting until decided
    },
  });

  if (r.kind === "ok" && r.receipt) {
    const body = r.body as { orderId?: string; eta?: string; card?: string; simulated?: boolean };
    agentLine("shopper", receiptLine(r.receipt), chalk.green);
    agentLine("shopper", `order ${ok(body.orderId ?? "?")} placed, ETA ${body.eta ?? "?"} ${dim(`(${body.card ?? ""}; simulated: ${body.simulated})`)}`, chalk.green);
    console.log("");
    console.log(`  ${ok("✔")} Approved by the owner, signed by the wallet, settled with a tx hash.`);
  } else {
    console.log(bad(`  ✖ pizza failed: ${JSON.stringify(r)}`));
    process.exitCode = 1;
  }
}

/** With --auto-approve, approve any pending approval for the shopper a moment after it appears. */
function startAutoApprover(): () => void {
  if (!AUTO_APPROVE) return () => {};
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.ownerApiKey) headers["x-owner-key"] = config.ownerApiKey;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${config.walletServiceUrl}/v1/approvals?status=pending`, { headers });
      const { approvals } = (await res.json()) as { approvals: Array<{ id: string; amount: string; agentName: string }> };
      for (const a of approvals ?? []) {
        await pace(1500);
        console.log(`  ${chalk.bgGreen.black(" OWNER ")} auto-approving ${money(a.amount)} for ${a.agentName} ${dim("(--auto-approve)")}`);
        await fetch(`${config.walletServiceUrl}/v1/approvals/${a.id}/approve`, { method: "POST", headers, body: JSON.stringify({ by: "auto" }) });
      }
    } catch {
      /* ignore */
    }
  }, 1000);
  return () => clearInterval(timer);
}

async function main() {
  banner(`Allowance demo  ·  ${config.chainMode} mode  ·  ${AUTO_APPROVE ? "auto-approve" : "owner approves on Telegram / dashboard"}`);
  await requireServices();
  const stop = startAutoApprover();
  try {
    if (ACTS.includes(1)) await actRace();
    if (ACTS.includes(2)) await actSpend();
    if (ACTS.includes(3)) await actAttack();
    if (ACTS.includes(4)) await actPizza();
  } finally {
    stop();
  }
  console.log("");
  banner(process.exitCode ? "Demo finished with errors" : "Demo complete");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(bad(`demo crashed: ${e?.stack ?? e}`));
  process.exit(1);
});

// keep the helper import used in every mode
void toBaseUnits;
void toDollars;
