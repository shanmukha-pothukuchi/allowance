/**
 * Test doubles: a scripted wallet-service and an x402 + agent-work merchant, both on port 0.
 * Not a test file (no .test.ts) — imported by server.test.ts.
 */
import express from "express";
import type { Server } from "node:http";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type {
  AgentWorkDoc,
  ApprovalWaitResponse,
  ClaimResponse,
  EarningRequest,
  MeResponse,
  PayRequest,
  PayResponse,
  PayoutResponse,
  Receipt,
  TransferRequest,
  TransferResponse,
} from "@allowance/shared";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532" as const;

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------- wallet stub

export interface WalletStub {
  url: string;
  token: string;
  address: `0x${string}`;
  /** Amount in dollars (number) at or below which payments are approved outright. */
  approveUpTo: number;
  /** Amount in dollars above which payments are blocked (between approveUpTo and this → needs_approval). */
  blockAbove: number;
  /** If set, pending approvals auto-approve after this many ms. null = stay pending until approve() is called. */
  autoApproveAfterMs: number | null;
  frozen: boolean;
  receipts: Receipt[];
  payRequests: PayRequest[];
  settledCalls: { paymentId: string; body: unknown }[];
  earnings: EarningRequest[];
  transfers: TransferRequest[];
  approvals: Map<string, { status: "pending" | "approved" | "denied" | "expired"; paymentId: string; paymentHeader?: string; receipt: Receipt }>;
  approve(approvalId: string): void;
  deny(approvalId: string): void;
  close(): Promise<void>;
}

let seq = 0;
const nid = (p: string) => `${p}_${(++seq).toString(16).padStart(6, "0")}`;

export async function startWalletStub(opts: Partial<Pick<WalletStub, "approveUpTo" | "blockAbove" | "autoApproveAfterMs">> = {}): Promise<WalletStub> {
  const token = "aw_" + "ab".repeat(24);
  const address = "0x1111111111111111111111111111111111111111" as const;
  const stub: WalletStub = {
    url: "",
    token,
    address,
    approveUpTo: opts.approveUpTo ?? 5,
    blockAbove: opts.blockAbove ?? 10,
    autoApproveAfterMs: opts.autoApproveAfterMs ?? null,
    frozen: false,
    receipts: [],
    payRequests: [],
    settledCalls: [],
    earnings: [],
    transfers: [],
    approvals: new Map(),
    approve(id) {
      const a = stub.approvals.get(id);
      if (!a || a.status !== "pending") return;
      a.status = "approved";
      a.paymentHeader = a.paymentHeader === undefined ? undefined : `hdr_${id}`;
      a.receipt.status = a.paymentHeader ? "signed" : "settled";
      if (!a.paymentHeader) {
        a.receipt.txHash = `0x${"c".repeat(64)}`;
        a.receipt.explorerUrl = `http://explorer.test/tx/${a.receipt.txHash}`;
      }
    },
    deny(id) {
      const a = stub.approvals.get(id);
      if (!a || a.status !== "pending") return;
      a.status = "denied";
      a.receipt.status = "denied";
    },
    close: async () => {},
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "unauthorized", message: "bad token" });
      return;
    }
    next();
  });

  const mkReceipt = (kind: Receipt["kind"], amount: string, description: string, extra: Partial<Receipt> = {}): Receipt => {
    const r: Receipt = {
      id: nid("rcp"),
      kind,
      status: "signed",
      agentId: "agt_test",
      agentName: "claude-desktop",
      description,
      amount,
      amountBaseUnits: String(Math.round(Number(amount) * 1e6)),
      counterparty: { address: "0x2222222222222222222222222222222222222222", name: description },
      network: NETWORK,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    stub.receipts.push(r);
    return r;
  };

  const me = (): MeResponse => ({
    agent: {
      id: "agt_test",
      name: "claude-desktop",
      address,
      policy: { maxPerTx: "20.00", dailyCap: "50.00", allowlist: { addresses: [], origins: ["http://localhost:4021"] }, approvalThreshold: "10.00", frozen: stub.frozen, freezeOnViolation: true },
      createdAt: new Date().toISOString(),
      balance: "20.00",
      spentToday: "0.05",
      earnedToday: "0.50",
      frozen: stub.frozen,
    },
    limits: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00", remainingToday: "49.95" },
  });

  app.get("/v1/me", (_req, res) => {
    res.json(me());
  });

  function decide(amountDollars: number, description: string, counterpartyName: string, kind: "spend" | "transfer", isX402: boolean): { status: number; body: PayResponse | TransferResponse } {
    const amount = amountDollars.toFixed(2);
    const paymentId = nid("pay");
    if (stub.frozen) {
      const receipt = mkReceipt(kind, amount, description, { status: "blocked", reason: "frozen", paymentId });
      return { status: 403, body: { status: "blocked", reason: "frozen", message: "Blocked: agent is frozen.", frozen: true, receipt } };
    }
    if (amountDollars > stub.blockAbove) {
      stub.frozen = true;
      const receipt = mkReceipt(kind, amount, description, { status: "blocked", reason: "max_per_tx", paymentId });
      return {
        status: 403,
        body: { status: "blocked", reason: "max_per_tx", message: `Blocked: tried to send $${amount} to ${counterpartyName}, over the $${stub.blockAbove.toFixed(2)} per-payment limit. Agent frozen.`, frozen: true, receipt },
      };
    }
    if (amountDollars > stub.approveUpTo) {
      const approvalId = nid("apr");
      const receipt = mkReceipt(kind, amount, description, { status: "pending_approval", paymentId, approvalId });
      stub.approvals.set(approvalId, { status: "pending", paymentId, paymentHeader: isX402 ? "" : undefined, receipt });
      if (stub.autoApproveAfterMs !== null) setTimeout(() => stub.approve(approvalId), stub.autoApproveAfterMs);
      const message = `Needs owner approval: $${amount} to ${counterpartyName}.`;
      if (isX402) return { status: 202, body: { status: "needs_approval", paymentId, approvalId, amount, message, receipt } };
      return { status: 202, body: { status: "needs_approval", approvalId, amount, message, receipt } };
    }
    if (isX402) {
      const receipt = mkReceipt(kind, amount, description, { status: "signed", paymentId });
      return { status: 200, body: { status: "approved", paymentId, paymentHeader: `hdr_${paymentId}`, receipt } };
    }
    const txHash = `0x${"d".repeat(64)}` as const;
    const receipt = mkReceipt(kind, amount, description, { status: "settled", txHash, explorerUrl: `http://explorer.test/tx/${txHash}`, settledAt: new Date().toISOString() });
    return { status: 200, body: { status: "sent", receipt } };
  }

  app.post("/v1/pay", (req, res) => {
    const body = req.body as PayRequest;
    stub.payRequests.push(body);
    const amountDollars = Number(body.paymentRequired.accepts[0].amount) / 1e6;
    const d = decide(amountDollars, body.description ?? body.url, body.description ?? body.url, "spend", true);
    res.status(d.status).json(d.body);
  });

  app.post("/v1/payments/:paymentId/settled", (req, res) => {
    stub.settledCalls.push({ paymentId: req.params.paymentId as string, body: req.body });
    const r = stub.receipts.find((x) => x.paymentId === req.params.paymentId);
    if (!r) {
      res.status(404).json({ error: "payment_not_found", message: "unknown payment" });
      return;
    }
    const tx = (req.body as { settleResponse: { transaction: string; success: boolean } }).settleResponse;
    r.status = tx.success ? "settled" : "failed";
    r.txHash = tx.transaction as `0x${string}`;
    r.explorerUrl = `http://explorer.test/tx/${tx.transaction}`;
    r.settledAt = new Date().toISOString();
    res.json({ receipt: r });
  });

  app.post("/v1/transfer", (req, res) => {
    const body = req.body as TransferRequest;
    stub.transfers.push(body);
    const d = decide(Number(body.amount), body.memo ?? "Transfer", body.to, "transfer", false);
    (d.body as { receipt: Receipt }).receipt.counterparty = { address: body.to };
    res.status(d.status).json(d.body);
  });

  app.get("/v1/approvals/:id/wait", async (req, res) => {
    const id = req.params.id as string;
    const timeoutMs = Number(req.query.timeoutMs ?? 45000);
    const started = Date.now();
    const a = stub.approvals.get(id);
    if (!a) {
      res.status(404).json({ error: "approval_not_found", message: "unknown approval" });
      return;
    }
    while (a.status === "pending" && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    let out: ApprovalWaitResponse;
    if (a.status === "pending") out = { status: "pending", approvalId: id };
    else if (a.status === "denied") out = { status: "denied", approvalId: id, receipt: a.receipt };
    else if (a.status === "expired") out = { status: "expired", approvalId: id };
    else out = { status: "approved", approvalId: id, paymentId: a.paymentId, paymentHeader: a.paymentHeader || undefined, receipt: a.receipt };
    res.json(out);
  });

  app.post("/v1/earnings", (req, res) => {
    const body = req.body as EarningRequest;
    stub.earnings.push(body);
    const r = mkReceipt("earn", body.amount, body.description, {
      status: "settled",
      txHash: body.txHash,
      explorerUrl: `http://explorer.test/tx/${body.txHash}`,
      counterparty: { address: body.from.address ?? "0x3333333333333333333333333333333333333333", origin: body.from.origin, name: body.from.name },
      settledAt: new Date().toISOString(),
    });
    res.json({ receipt: r });
  });

  app.get("/v1/receipts", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ receipts: stub.receipts.slice(-limit).reverse() });
  });

  const { server, url } = await listen(app);
  stub.url = url;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

// ---------------------------------------------------------------------------- merchant stub

export interface MerchantStub {
  url: string;
  claims: Map<string, { bountyId: string; walletAddress: string; expiresAt: string; paid?: PayoutResponse }>;
  submits: unknown[];
  paidRequests: { path: string; signature: string }[];
  slotsRemaining: number;
  close(): Promise<void>;
}

export async function startMerchantStub(): Promise<MerchantStub> {
  const stub: MerchantStub = { url: "", claims: new Map(), submits: [], paidRequests: [], slotsRemaining: 3, close: async () => {} };
  const app = express();
  app.use(express.json());

  const paid = (path: string, amountBaseUnits: string, serviceName: string, handler: (req: express.Request) => unknown) => {
    const route = (req: express.Request, res: express.Response) => {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        res.setHeader(
          "PAYMENT-REQUIRED",
          encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: `${stub.url}${path}`, description: serviceName, serviceName: "Acme APIs" },
            accepts: [{ scheme: "exact", network: NETWORK, amount: amountBaseUnits, asset: USDC, payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }],
          }),
        );
        res.status(402).json({});
        return;
      }
      stub.paidRequests.push({ path, signature: String(sig) });
      const tx = `0x${"a".repeat(60)}${stub.paidRequests.length.toString(16).padStart(4, "0")}`;
      res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader({ success: true, transaction: tx, network: NETWORK, payer: "0x1111111111111111111111111111111111111111" }));
      res.json(handler(req));
    };
    app.get(path, route);
    app.post(path, route);
  };

  paid("/api/weather", "50000", "Acme Weather", (req) => ({ city: req.query.city ?? "Berlin", tempC: 17, summary: "cloudy" }));
  paid("/pizza/order", "8000000", "Pizza Co", (req) => ({ orderId: "ord_1", status: "placed", eta: "25 min", size: req.body?.size ?? "large", simulated: true }));
  paid("/api/expensive", "50000000", "Gold Plated API", () => ({ gold: true }));

  app.get("/free", (_req, res) => {
    res.type("text/plain").send("hello, free world");
  });
  app.get("/big", (_req, res) => {
    res.type("text/plain").send("x".repeat(30_000));
  });
  app.get("/test-target/:name", (req, res) => {
    if (req.params.name === "orders" || req.params.name === "inventory") res.status(500).json({ error: "boom" });
    else res.json({ ok: true, name: req.params.name });
  });

  const bountyId = "api-reliability-check";
  const endpoints = () => ["users", "orders", "products", "inventory", "health"].map((n) => `${stub.url}/test-target/${n}`);
  app.get("/.well-known/agent-work", (req, res) => {
    res.setHeader("Vary", "Accept");
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.type("html").send("<h1>board</h1>");
      return;
    }
    const doc: AgentWorkDoc = {
      protocol: "agent-work",
      version: "0.1",
      site: { name: "Acme APIs", url: stub.url },
      bounties: [
        {
          id: bountyId,
          title: "API reliability check",
          description: "Call each endpoint in input.endpoints once and report which ones fail.",
          taskType: "api_reliability_check",
          input: { endpoints: endpoints() },
          payout: { amount: "0.50", asset: "USDC", network: NETWORK },
          slots: { total: 3, remaining: stub.slotsRemaining },
          claimTtlSeconds: 600,
          claimUrl: `${stub.url}/agent-work/bounties/${bountyId}/claim`,
          submitUrl: `${stub.url}/agent-work/bounties/${bountyId}/submit`,
          verification: "Your list of failing endpoints is compared to the known answer.",
          status: stub.slotsRemaining > 0 ? "open" : "full",
        },
      ],
    };
    res.json(doc);
  });

  app.post("/agent-work/bounties/:id/claim", (req, res) => {
    if (req.params.id !== bountyId) {
      res.status(404).json({ error: "bounty_not_found", message: "no such bounty" });
      return;
    }
    const walletAddress = (req.body as { walletAddress?: string }).walletAddress;
    if (!walletAddress) {
      res.status(400).json({ error: "invalid_request", message: "walletAddress required" });
      return;
    }
    if ([...stub.claims.values()].some((c) => c.walletAddress === walletAddress)) {
      res.status(409).json({ error: "already_claimed", message: "one slot per wallet" });
      return;
    }
    if (stub.slotsRemaining <= 0) {
      res.status(409).json({ error: "bounty_full", message: "no slots" });
      return;
    }
    stub.slotsRemaining--;
    const claimId = nid("clm");
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    stub.claims.set(claimId, { bountyId, walletAddress, expiresAt });
    const out: ClaimResponse = { claimId, bountyId, walletAddress: walletAddress as `0x${string}`, expiresAt, submitUrl: `${stub.url}/agent-work/bounties/${bountyId}/submit`, input: { endpoints: endpoints() } };
    res.status(201).json(out);
  });

  app.post("/agent-work/bounties/:id/submit", (req, res) => {
    const body = req.body as { claimId: string; walletAddress: string; result: { failing?: string[] } };
    stub.submits.push(body);
    const claim = stub.claims.get(body.claimId);
    if (!claim || claim.walletAddress !== body.walletAddress) {
      res.status(404).json({ error: "claim_not_found", message: "unknown claim" });
      return;
    }
    if (claim.expiresAt < new Date().toISOString()) {
      res.status(410).json({ error: "claim_expired", message: "too late" });
      return;
    }
    if (claim.paid) {
      res.json(claim.paid);
      return;
    }
    const expected = new Set([`${stub.url}/test-target/orders`, `${stub.url}/test-target/inventory`]);
    const got = new Set(body.result?.failing ?? []);
    const ok = got.size === expected.size && [...expected].every((e) => got.has(e));
    if (!ok) {
      res.status(422).json({ error: "rejected", message: "failing list does not match", details: { expectedCount: expected.size, gotCount: got.size } });
      return;
    }
    const txHash = `0x${"b".repeat(64)}` as const;
    const payout: PayoutResponse = { status: "paid", claimId: body.claimId, bountyId, amount: "0.50", asset: "USDC", network: NETWORK, to: body.walletAddress as `0x${string}`, txHash, explorerUrl: `http://explorer.test/tx/${txHash}`, paidAt: new Date().toISOString() };
    claim.paid = payout;
    res.setHeader("PAYOUT-RESPONSE", Buffer.from(JSON.stringify(payout)).toString("base64"));
    res.json(payout);
  });

  const { server, url } = await listen(app);
  stub.url = url;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
