import { describe, expect, it } from "vitest";
import {
  accountFor,
  bankFromEvent,
  bankMarker,
  checkingLine,
  entryAmount,
  entryTitle,
  feedMarker,
  foldBankEvents,
  masked,
  movedLine,
  nessieStatus,
  queueLine,
  short,
  sourceLine,
  statementDate,
  statusTone,
  topupBankError,
} from "./bank";
import { initialState, reducer } from "./state";
import type { BankSummary, Receipt, SummaryResponse, WalletEvent } from "./types";

const receipt = (id: string, extra: Partial<Receipt> = {}): Receipt => ({
  id,
  kind: "spend",
  status: "settled",
  agentId: "agt_r",
  agentName: "researcher",
  description: "Acme News",
  amount: "0.10",
  amountBaseUnits: "100000",
  counterparty: { address: "0x2222222222222222222222222222222222222222", name: "Acme News" },
  network: "eip155:84532",
  createdAt: "2026-10-18T12:00:00Z",
  ...extra,
});
const event = (id: string, type: WalletEvent["type"], r?: Receipt, data?: Record<string, unknown>): WalletEvent => ({
  id,
  type,
  at: "2026-10-18T12:00:01Z",
  agentId: "agt_r",
  agentName: "researcher",
  message: "",
  ...(r ? { receipt: r } : {}),
  ...(data ? { data } : {}),
});
const summary = (bank?: SummaryResponse["bank"]): SummaryResponse => ({
  totalBalance: "20.00",
  spentToday: "0.00",
  earnedToday: "0.00",
  agents: [],
  pendingApprovals: [],
  chainMode: "mock",
  telegramConnected: false,
  ...(bank ? { bank } : {}),
});

describe("bank lines (§16.5)", () => {
  it("masks account numbers the way the wallet sends them", () => {
    expect(masked("1234")).toBe("••1234");
    expect(masked("••1234")).toBe("••1234");
    expect(masked("a1b2c3d4")).toBe("••a1b2c3d4"); // alphanumeric, up to 8
    expect(masked("")).toBe("");
    expect(masked(undefined)).toBe("");
  });

  it("says where the money is and where it moved, in the contract's words", () => {
    const b = { linked: true, checkingLast4: "1234", checkingBalance: "4982" };
    expect(checkingLine(b)).toBe("Capital One Checking ••1234 · $4,982.00");
    expect(sourceLine(b)).toBe("From Capital One Checking ••1234 · $4,982.00 available");
    expect(movedLine("20.00", "shopper")).toBe("Moved $20.00 from Checking to shopper's allowance account");
    expect(short(b, "5000.00")).toBe(true);
    expect(short(b, "20.00")).toBe(false);
    expect(short(null, "5000.00")).toBe(false);
  });

  it("shows the bank's top-up errors plainly, its words first", () => {
    expect(topupBankError("bank_insufficient_funds", "Your Capital One checking has $75.00, not enough to add $100.00.")).toBe(
      "Your Capital One checking has $75.00, not enough to add $100.00.",
    );
    expect(topupBankError("bank_insufficient_funds", "bank_insufficient_funds", { checking: "12.4", amount: "20" })).toBe(
      "Your Capital One checking has $12.40, not enough to add $20.00.",
    );
    expect(topupBankError("bank_unavailable", "")).toBe("Capital One didn't confirm the transfer, so nothing was added.");
    expect(topupBankError("invalid_request", "nope")).toBeNull();
    expect(topupBankError(undefined, "boom")).toBeNull();
  });
});

describe("receipt markers", () => {
  it("posted, queued, failed (with Retry), and blocked when linked", () => {
    expect(bankMarker(receipt("r1", { bank: { status: "posted", account: "••3307", ref: "n1" } }), true)).toMatchObject({ tone: "posted", text: "On Capital One statement" });
    expect(bankMarker(receipt("r2", { bank: { status: "queued", account: "" } }), true)).toMatchObject({ tone: "queued", text: "Posting to Capital One…" });
    expect(bankMarker(receipt("r3", { bank: { status: "failed", account: "••3307", error: "Nessie said 500" } }), true)).toMatchObject({
      tone: "failed",
      text: "Not on statement",
      retry: true,
      title: "Capital One: Nessie said 500",
    });
    expect(bankMarker(receipt("r4", { status: "blocked" }), true)).toMatchObject({ tone: "stopped", text: "Stopped before it reached your bank" });
    expect(bankMarker(receipt("r5", { status: "denied" }), true)?.tone).toBe("stopped");
  });

  it("nothing at all without a bank, or for receipts that never reach it", () => {
    expect(bankMarker(receipt("r4", { status: "blocked" }), false)).toBeNull();
    expect(bankMarker(receipt("r6"), true)).toBeNull();
    expect(bankMarker(undefined, true)).toBeNull();
  });

  it("marks one feed row per payment: the settled row, not its signing or approval rows", () => {
    const r = receipt("r1", { bank: { status: "posted", account: "••3307" } });
    expect(feedMarker(event("e1", "payment.settled", r), true)?.tone).toBe("posted");
    expect(feedMarker(event("e2", "payment.signed", r), true)).toBeNull();
    expect(feedMarker(event("e3", "approval.approved", r), true)).toBeNull();
    expect(feedMarker(event("e4", "payment.blocked", receipt("r9", { status: "blocked" })), true)?.tone).toBe("stopped");
  });
});

describe("bank events", () => {
  it("reads the new bank state from the receipt, else from data", () => {
    const posted = receipt("r1", { bank: { status: "posted", account: "••3307", ref: "n1" } });
    expect(bankFromEvent(event("e1", "bank.posted", posted))).toEqual({ receiptId: "r1", bank: posted.bank });
    expect(bankFromEvent(event("e2", "bank.posted", undefined, { receiptId: "r1", ref: "n1", kind: "purchase", account: "••3307" }))).toEqual({
      receiptId: "r1",
      bank: { status: "posted", account: "••3307", ref: "n1" },
    });
    expect(bankFromEvent(event("e3", "bank.failed", receipt("r2"), { receiptId: "r2", kind: "purchase", error: "Nessie said 500" }))).toEqual({
      receiptId: "r2",
      bank: { status: "failed", account: "", error: "Nessie said 500" },
    });
    expect(bankFromEvent(event("e4", "payment.settled", posted))).toBeNull();
  });

  it("folds a snapshot's bank events into the rows they update, and drops them as rows", () => {
    const queued = receipt("r1", { bank: { status: "queued", account: "••3307" } });
    const posted = { ...queued, bank: { status: "posted" as const, account: "••3307", ref: "n1" } };
    const feed = foldBankEvents([event("e2", "bank.posted", posted), event("e1", "payment.settled", queued)]);
    expect(feed.map((e) => e.id)).toEqual(["e1"]);
    expect(feed[0].receipt?.bank?.status).toBe("posted");
    // the receipts list is current and wins over an older event
    const failed = { ...queued, bank: { status: "failed" as const, account: "••3307" } };
    expect(foldBankEvents([event("e1", "payment.settled", queued)], [failed])[0].receipt?.bank?.status).toBe("failed");
  });

  it("a live bank event updates the receipt and every feed row showing it, without a row of its own", () => {
    const queued = receipt("r1", { bank: { status: "queued", account: "••3307" } });
    let s = reducer(initialState, { type: "loaded", summary: summary({ linked: true, checkingLast4: "1234", checkingBalance: "4840.00" }), events: [event("e1", "payment.settled", queued)], receipts: [queued], approvals: [] });
    s = reducer(s, { type: "event", event: event("e2", "bank.failed", { ...queued, bank: { status: "failed", account: "••3307", error: "500" } }) });
    expect(s.events.map((e) => e.id)).toEqual(["e1"]);
    expect(s.events[0].receipt?.bank?.status).toBe("failed");
    expect(s.receipts[0].bank?.status).toBe("failed");
    expect(s.totals.bank).toEqual({ linked: true, checkingLast4: "1234", checkingBalance: "4840.00" });
  });

  it("a retry puts that receipt (or every failed one) back to posting", () => {
    const failed = (id: string) => receipt(id, { bank: { status: "failed", account: "••3307" } });
    const bank: BankSummary = { enabled: true, linked: true, provider: "Capital One", sandbox: "Nessie", accounts: [], queue: { pending: 0, failed: 2 }, updatedAt: "2026-10-18T12:00:00Z" };
    let s = reducer(initialState, { type: "loaded", summary: summary(), events: [event("e1", "payment.settled", failed("r1"))], receipts: [failed("r1"), failed("r2")], approvals: [] });
    s = reducer(s, { type: "bank", bank });
    const one = reducer(s, { type: "bankRetried", receiptId: "r1" });
    expect(one.receipts.map((r) => r.bank?.status)).toEqual(["queued", "failed"]);
    expect(one.events[0].receipt?.bank?.status).toBe("queued");
    expect(one.bank?.queue).toEqual({ pending: 1, failed: 1 });
    const all = reducer(s, { type: "bankRetried" });
    expect(all.receipts.map((r) => r.bank?.status)).toEqual(["queued", "queued"]);
    expect(all.bank?.queue).toEqual({ pending: 2, failed: 0 });
  });

  it("no bank in the summary: totals carry none", () => {
    const s = reducer(initialState, { type: "loaded", summary: summary(), events: [], receipts: [], approvals: [] });
    expect(s.totals.bank).toBeNull();
    expect(s.bank).toBeNull();
  });
});

describe("statements", () => {
  it("names entries by merchant, signs amounts, and keeps Nessie's status", () => {
    expect(entryTitle({ kind: "purchase", merchant: "Quantcomm Flood Research", description: "Quantcomm alerts · paid in USDC" })).toBe("Quantcomm Flood Research");
    expect(entryTitle({ kind: "purchase", description: "Acme News · paid in USDC" })).toBe("Acme News");
    expect(entryTitle({ kind: "transfer_in", description: "Allowance top-up · shopper" })).toBe("Top-up from Checking");
    expect(entryTitle({ kind: "transfer_out", description: "Allowance top-up · shopper" })).toBe("To shopper's allowance account");
    expect(entryTitle({ kind: "transfer_out", description: "Allowance top-up reversed · shopper" })).toBe("Top-up reversed to Checking");
    expect(entryTitle({ kind: "deposit", description: "Earned · Bounty: API reliability check" })).toBe("Bounty: API reliability check");
    expect(entryAmount({ kind: "purchase", amount: "0.05" })).toBe("−$0.05");
    expect(entryAmount({ kind: "deposit", amount: "0.5" })).toBe("+$0.50");
    expect(entryAmount({ kind: "transfer_in", amount: "1000" })).toBe("+$1,000.00");
    expect(nessieStatus("executed")).toBe("Executed");
    expect(nessieStatus(undefined)).toBe("");
    expect([statusTone("pending"), statusTone("executed"), statusTone("completed"), statusTone("cancelled"), statusTone("weird")]).toEqual(["pending", "done", "done", "void", "other"]);
  });

  it("reads bank dates as calendar days, not UTC instants", () => {
    const now = new Date(2026, 9, 18, 23, 30).getTime();
    expect(statementDate("2026-10-18", now)).toBe("Today");
    expect(statementDate("2026-10-17", now)).toBe("Yesterday");
    expect(statementDate("2026-10-03", now)).toBe("Oct 3");
    expect(statementDate("2025-12-31", now)).toBe("Dec 31, 2025");
    expect(statementDate("not a date", now)).toBe("not a date");
  });

  it("summarizes the queue and finds an agent's account", () => {
    expect(queueLine({ pending: 2, failed: 1 })).toBe("2 posting · 1 not on statement");
    expect(queueLine({ pending: 0, failed: 0 })).toBeNull();
    const bank: BankSummary = {
      enabled: true,
      linked: true,
      provider: "Capital One",
      sandbox: "Nessie",
      accounts: [{ agentId: "agt_r", agentName: "researcher", id: "n1", nickname: "Allowance · researcher", last4: "3307", balance: "19.85" }],
      queue: { pending: 0, failed: 0 },
      updatedAt: "2026-10-18T12:00:00Z",
    };
    expect(accountFor(bank, "agt_r")?.last4).toBe("3307");
    expect(accountFor(bank, "agt_x")).toBeUndefined();
    expect(accountFor(null, "agt_r")).toBeUndefined();
  });
});
