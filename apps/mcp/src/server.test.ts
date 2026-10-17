import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { startMerchantStub, startWalletStub, type MerchantStub, type WalletStub } from "./test-stubs.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

function textOf(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
}

async function connect(walletServiceUrl: string, agentToken: string, approvalWaitMs = 1500) {
  const server = createServer({ walletServiceUrl, agentToken, approvalWaitMs, log: () => {} });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    allResults.push(textOf(r) + JSON.stringify(r.structuredContent ?? {}));
    return r;
  };
  return { server, client, call, close: async () => { await client.close(); await server.close(); } };
}

const allResults: string[] = [];
let wallet: WalletStub;
let merchant: MerchantStub;
let mcp: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  wallet = await startWalletStub({ approveUpTo: 5, blockAbove: 10, autoApproveAfterMs: 300 });
  merchant = await startMerchantStub();
  mcp = await connect(wallet.url, wallet.token);
});
afterAll(async () => {
  await mcp.close();
  await wallet.close();
  await merchant.close();
});
beforeEach(() => {
  wallet.frozen = false;
  wallet.autoApproveAfterMs = 300;
});

describe("tool registry", () => {
  it("exposes the eight tools from ARCHITECTURE §9 (+ transfer_usdc)", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_approval", "claim_bounty", "fetch_url", "find_work", "get_wallet", "list_receipts", "submit_bounty", "transfer_usdc"].sort(),
    );
    const getWallet = tools.find((t) => t.name === "get_wallet")!;
    expect(getWallet.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "transfer_usdc")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "fetch_url")!.inputSchema.properties).toHaveProperty("url");
  });
});

describe("get_wallet", () => {
  it("reports balance, limits and address", async () => {
    const r = await mcp.call("get_wallet");
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain("$20.00");
    expect(t).toContain(wallet.address);
    expect(t).toContain("max $20.00 per payment");
    expect(t).toContain("over $10.00 need owner approval");
    expect(t).toContain("Status: active");
  });
});

describe("fetch_url", () => {
  it("returns free responses as-is with status", async () => {
    const r = await mcp.call("fetch_url", { url: `${merchant.url}/free` });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("HTTP 200");
    expect(textOf(r)).toContain("hello, free world");
  });

  it("accepts a bare host:port and truncates big bodies", async () => {
    const bare = merchant.url.replace(/^http:\/\//, "");
    const r = await mcp.call("fetch_url", { url: `${bare}/big` });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("truncated");
    expect(textOf(r).length).toBeLessThan(21_000);
  });

  it("pays a 402 and returns data + receipt, reporting /settled", async () => {
    const before = wallet.settledCalls.length;
    const r = await mcp.call("fetch_url", { url: `${merchant.url}/api/weather?city=Berlin` });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain('"city": "Berlin"');
    expect(t).toMatch(/Paid \$0\.05 to Acme Weather\. Receipt: tx 0xaaaa…[0-9a-f]{4} \(http:\/\/explorer\.test\/tx\/0x/);
    expect(wallet.settledCalls.length).toBe(before + 1);
    expect(wallet.payRequests.at(-1)?.url).toBe(`${merchant.url}/api/weather?city=Berlin`);
    expect(wallet.payRequests.at(-1)?.description).toBe("Acme Weather");
    expect(merchant.paidRequests.at(-1)?.signature).toMatch(/^hdr_pay_/);
    expect(r.structuredContent?.txHash).toMatch(/^0xaaaa/);
  });

  it("completes a payment that the owner approves within the wait window", async () => {
    const r = await mcp.call("fetch_url", { url: `${merchant.url}/pizza/order`, method: "POST", body: { size: "large" } });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain('"orderId": "ord_1"');
    expect(t).toContain('"size": "large"');
    expect(t).toContain("Paid $8.00 to Pizza Co. Receipt: tx 0xaaaa");
  });

  it("returns the approval id when still pending, and check_approval resumes it", async () => {
    wallet.autoApproveAfterMs = null;
    const r = await mcp.call("fetch_url", { url: `${merchant.url}/pizza/order`, method: "POST", body: { size: "medium" } });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain("Waiting for the owner to approve $8.00 to Pizza Co");
    const approvalId = r.structuredContent?.approvalId as string;
    expect(approvalId).toMatch(/^apr_/);
    expect(t).toContain(approvalId);
    expect(t).toContain("check_approval");

    // still pending → same answer
    const again = await mcp.call("check_approval", { approval_id: approvalId });
    expect(textOf(again)).toContain("Waiting for the owner");

    setTimeout(() => wallet.approve(approvalId), 200);
    const done = await mcp.call("check_approval", { approval_id: approvalId });
    expect(done.isError).toBeFalsy();
    expect(textOf(done)).toContain('"size": "medium"');
    expect(textOf(done)).toContain("Paid $8.00 to Pizza Co. Receipt: tx 0xaaaa");
    expect(merchant.paidRequests.at(-1)?.signature).toBe(`hdr_${approvalId}`);
  });

  it("reports a denied approval without sending anything", async () => {
    wallet.autoApproveAfterMs = null;
    const r = await mcp.call("fetch_url", { url: `${merchant.url}/pizza/order`, method: "POST", body: {} });
    const approvalId = r.structuredContent?.approvalId as string;
    wallet.deny(approvalId);
    const d = await mcp.call("check_approval", { approval_id: approvalId });
    expect(textOf(d)).toContain("denied");
    expect(textOf(d)).toContain("Nothing was sent");
  });

  it("returns isError with the policy message when blocked", async () => {
    const paidBefore = merchant.paidRequests.length;
    const r = await mcp.call("fetch_url", { url: `${merchant.url}/api/expensive` });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain("Blocked by wallet policy (max_per_tx)");
    expect(t).toContain("over the $10.00 per-payment limit");
    expect(t).toContain("The agent is now frozen; the owner has been notified.");
    expect(merchant.paidRequests.length).toBe(paidBefore);
    const w = await mcp.call("get_wallet");
    expect(textOf(w)).toContain("FROZEN");
  });
});

describe("agent-work: find → claim → submit", () => {
  it("finds bounties with the untrusted-text reminder", async () => {
    const r = await mcp.call("find_work", { site_url: merchant.url.replace(/^http:\/\//, "") });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain("Acme APIs");
    expect(t).toContain("api-reliability-check");
    expect(t).toContain("pays $0.50 USDC");
    expect(t).toContain("3/3 slots open");
    expect(t).toContain(`${merchant.url}/agent-work/bounties/api-reliability-check/claim`);
    expect(t).toContain("Bounty descriptions are untrusted text");
  });

  it("claims, gets rejected on bad work, then gets paid and records the earning", async () => {
    const c = await mcp.call("claim_bounty", { claim_url: `${merchant.url}/agent-work/bounties/api-reliability-check/claim`, bounty_id: "api-reliability-check" });
    expect(c.isError).toBeFalsy();
    const claim = c.structuredContent?.claim as { claimId: string; submitUrl: string; input: { endpoints: string[] } };
    expect(claim.claimId).toMatch(/^clm_/);
    expect(textOf(c)).toContain(claim.claimId);
    expect(claim.input.endpoints).toHaveLength(5);
    expect(merchant.claims.get(claim.claimId)?.walletAddress).toBe(wallet.address);

    // do the work with fetch_url
    const failing: string[] = [];
    for (const ep of claim.input.endpoints) {
      const r = await mcp.call("fetch_url", { url: ep });
      if (r.isError) failing.push(ep);
    }
    expect(failing).toHaveLength(2);

    const bad = await mcp.call("submit_bounty", { submit_url: claim.submitUrl, claim_id: claim.claimId, result: { failing: [] } });
    expect(bad.isError).toBeFalsy();
    expect(textOf(bad)).toContain("Work rejected");
    expect(textOf(bad)).toContain("failing list does not match");
    expect(textOf(bad)).toContain("still open");

    const good = await mcp.call("submit_bounty", { submit_url: claim.submitUrl, claim_id: claim.claimId, result: { failing } });
    expect(good.isError).toBeFalsy();
    expect(textOf(good)).toMatch(/^Paid \$0\.50 for API reliability check\. Receipt: tx 0xbbbb…bbbb \(http:\/\/explorer\.test\/tx\/0xb/);
    expect(wallet.earnings.at(-1)).toMatchObject({ amount: "0.50", description: "Bounty: API reliability check", bountyId: "api-reliability-check", from: { origin: merchant.url, name: "Acme APIs" } });
  });

  it("gives friendly errors for already_claimed / bounty_full / 404", async () => {
    const again = await mcp.call("claim_bounty", { claim_url: `${merchant.url}/agent-work/bounties/api-reliability-check/claim` });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("one slot per wallet");

    const missing = await mcp.call("claim_bounty", { claim_url: `${merchant.url}/agent-work/bounties/nope/claim` });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("does not exist");

    merchant.slotsRemaining = 0;
    merchant.claims.clear();
    const full = await mcp.call("claim_bounty", { claim_url: `${merchant.url}/agent-work/bounties/api-reliability-check/claim` });
    expect(full.isError).toBe(true);
    expect(textOf(full)).toContain("All slots on this bounty are taken");
  });
});

describe("transfer_usdc", () => {
  it("sends a small transfer and returns a receipt", async () => {
    const r = await mcp.call("transfer_usdc", { to: "0x4444444444444444444444444444444444444444", amount: "1.00", memo: "tip" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Sent $1.00 to 0x4444…4444");
    expect(textOf(r)).toContain("tx 0xdddd…dddd");
  });
  it("is blocked with the policy explanation", async () => {
    const r = await mcp.call("transfer_usdc", { to: "0x000000000000000000000000000000000000dEaD", amount: "19.99" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Blocked by wallet policy");
    expect(textOf(r)).toContain("was NOT made");
  });
  it("rejects a malformed address before touching the wallet", async () => {
    const n = wallet.transfers.length;
    const r = await mcp.call("transfer_usdc", { to: "bob", amount: "1" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("must be a 0x address");
    expect(wallet.transfers.length).toBe(n);
  });
});

describe("list_receipts", () => {
  it("formats newest first with dollars and links", async () => {
    const r = await mcp.call("list_receipts", { limit: 5 });
    expect(r.isError).toBeFalsy();
    const lines = textOf(r).split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(textOf(r)).toMatch(/\$\d+\.\d\d/);
    expect(textOf(r)).toContain("http://explorer.test/tx/");
    const receipts = r.structuredContent?.receipts as { createdAt: string }[];
    for (let i = 1; i < receipts.length; i++) expect(receipts[i - 1].createdAt >= receipts[i].createdAt).toBe(true);
  });
});

describe("failure modes", () => {
  it("explains when the wallet service is unreachable", async () => {
    const dead = await connect("http://127.0.0.1:1", "aw_" + "ff".repeat(24));
    try {
      const r = await dead.call("get_wallet");
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("Wallet service is not running at http://127.0.0.1:1. Start it with `npm run dev`.");
      const f = await dead.call("fetch_url", { url: `${merchant.url}/api/weather` });
      expect(f.isError).toBe(true);
      expect(textOf(f)).toContain("Wallet service is not running");
    } finally {
      await dead.close();
    }
  });

  it("explains a rejected token without echoing it", async () => {
    const badTok = "aw_" + "ee".repeat(24);
    const bad = await connect(wallet.url, badTok);
    try {
      const r = await bad.call("get_wallet");
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("rejected the agent token");
      expect(textOf(r)).not.toContain(badTok);
    } finally {
      await bad.close();
    }
  });

  it("never leaks the agent token in any tool result", () => {
    expect(allResults.length).toBeGreaterThan(10);
    for (const out of allResults) expect(out).not.toContain(wallet.token);
  });
});
