import { describe, expect, it } from "vitest";
import { collapseFeed, MAX_FEED, applyEvent, initialState, isMoneyEvent, reducer, type DashboardState } from "./state";
import type { AgentPublic, Approval, Receipt, SummaryResponse, WalletEvent } from "./types";

const policy: AgentPublic["policy"] = { maxPerTx: "2.00", dailyCap: "10.00", allowlist: null, approvalThreshold: "2.00", frozen: false, freezeOnViolation: true };
const agent = (id: string, name: string): AgentPublic => ({
  id,
  name,
  address: "0x1111111111111111111111111111111111111111",
  policy: { ...policy },
  createdAt: "2026-10-17T00:00:00Z",
  balance: "20.00",
  spentToday: "0.00",
  earnedToday: "0.00",
  frozen: false,
});
const summary: SummaryResponse = {
  totalBalance: "40.00",
  spentToday: "0.00",
  earnedToday: "0.00",
  agents: [agent("agt_a", "naive-worker"), agent("agt_b", "shopper")],
  pendingApprovals: [],
  chainMode: "mock",
  telegramConnected: false,
};
const receipt = (id: string, extra: Partial<Receipt> = {}): Receipt => ({
  id,
  kind: "spend",
  status: "signed",
  agentId: "agt_b",
  agentName: "shopper",
  description: "Pizza order",
  amount: "18.50",
  amountBaseUnits: "18500000",
  counterparty: { address: "0x2222222222222222222222222222222222222222", name: "Pizza" },
  network: "eip155:84532",
  createdAt: "2026-10-17T12:00:00Z",
  ...extra,
});
const approval: Approval = {
  id: "apr_1",
  agentId: "agt_b",
  agentName: "shopper",
  paymentId: "pay_1",
  amount: "18.50",
  description: "Pizza order",
  counterparty: { address: "0x2222222222222222222222222222222222222222", name: "Pizza" },
  status: "pending",
  createdAt: "2026-10-17T12:00:00Z",
};
let n = 0;
const ev = (type: WalletEvent["type"], extra: Partial<WalletEvent> = {}): WalletEvent => ({
  id: `evt_${++n}`,
  type,
  at: new Date(Date.parse("2026-10-17T12:00:00Z") + n * 1000).toISOString(),
  message: "",
  ...extra,
});

function loaded(): DashboardState {
  return reducer(initialState, { type: "loaded", summary, events: [], receipts: [], approvals: [] });
}

describe("reducer: loaded", () => {
  it("takes agents and totals from the summary, keeps only pending approvals", () => {
    const s = reducer(initialState, {
      type: "loaded",
      summary,
      events: [ev("payment.signed"), ev("payment.settled")],
      receipts: [receipt("rcp_1")],
      approvals: [approval, { ...approval, id: "apr_old", status: "approved" }],
    });
    expect(s.loaded).toBe(true);
    expect(s.agents.map((a) => a.name)).toEqual(["naive-worker", "shopper"]);
    expect(s.totals.totalBalance).toBe("40.00");
    expect(s.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    expect(s.events[0].type).toBe("payment.settled"); // newest first
  });
});

describe("applyEvent", () => {
  it("prepends events, dedupes by id, caps the feed at 200", () => {
    let s = loaded();
    const e = ev("payment.signed");
    s = applyEvent(s, e);
    s = applyEvent(s, e);
    expect(s.events).toHaveLength(1);
    for (let i = 0; i < MAX_FEED + 20; i++) s = applyEvent(s, ev("earning.received"));
    expect(s.events).toHaveLength(MAX_FEED);
    expect(s.events[0].id).toBe(`evt_${n}`);
  });

  it("freezes and unfreezes agents with the reason", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.blocked", { agentId: "agt_a", agentName: "naive-worker", reason: "not_allowlisted", receipt: receipt("rcp_b", { status: "blocked", kind: "transfer" }) }));
    s = applyEvent(s, ev("agent.frozen", { agentId: "agt_a", agentName: "naive-worker", reason: "Blocked: tried to send $20.00 to an unknown address. Agent frozen." }));
    const a = s.agents.find((x) => x.id === "agt_a")!;
    expect(a.frozen).toBe(true);
    expect(a.policy.frozen).toBe(true);
    expect(a.frozenReason).toMatch(/unknown address/);
    expect(s.agents.find((x) => x.id === "agt_b")!.frozen).toBe(false);
    expect(s.receipts[0].status).toBe("blocked");

    s = applyEvent(s, ev("agent.unfrozen", { agentId: "agt_a" }));
    expect(s.agents.find((x) => x.id === "agt_a")!.frozen).toBe(false);
    expect(s.agents.find((x) => x.id === "agt_a")!.frozenReason).toBeUndefined();
  });

  it("tracks approvals from needs_approval through approved/denied", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.needs_approval", { agentId: "agt_b", approval, receipt: receipt("rcp_p", { status: "pending_approval", approvalId: "apr_1" }) }));
    expect(s.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    // duplicate needs_approval for same approval id is ignored
    s = applyEvent(s, ev("payment.needs_approval", { agentId: "agt_b", approval }));
    expect(s.approvals).toHaveLength(1);

    s = applyEvent(s, ev("approval.approved", { agentId: "agt_b", approval: { ...approval, status: "approved" }, receipt: receipt("rcp_p", { status: "signed", approvalId: "apr_1" }) }));
    expect(s.approvals).toHaveLength(0);
    expect(s.receipts.find((r) => r.id === "rcp_p")!.status).toBe("signed");
    expect(s.receipts).toHaveLength(1); // upsert, not duplicate
  });

  it("removes an approval on deny using the receipt link when approval is absent", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.needs_approval", { approval }));
    s = applyEvent(s, ev("approval.denied", { receipt: receipt("rcp_p", { status: "denied", approvalId: "apr_1" }) }));
    expect(s.approvals).toHaveLength(0);
  });

  it("upserts receipts: signed then settled keeps one row with the tx hash", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.signed", { receipt: receipt("rcp_1") }));
    s = applyEvent(s, ev("payment.settled", { receipt: receipt("rcp_1", { status: "settled", txHash: "0xabc" }) }));
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].status).toBe("settled");
    expect(s.receipts[0].txHash).toBe("0xabc");
  });

  it("collapses the signed row once the same payment settles", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.signed", { receipt: receipt("rcp_1") }));
    s = applyEvent(s, ev("payment.signed", { receipt: receipt("rcp_2") }));
    s = applyEvent(s, ev("payment.settled", { receipt: receipt("rcp_1", { status: "settled" }) }));
    expect(s.events.map((e) => `${e.type}:${e.receipt?.id}`)).toEqual(["payment.settled:rcp_1", "payment.signed:rcp_2"]);
  });

  it("bumps the agent balance optimistically on topup", () => {
    let s = loaded();
    s = applyEvent(s, ev("topup", { agentId: "agt_a", receipt: receipt("rcp_t", { kind: "topup", status: "settled", amount: "20.00", agentId: "agt_a" }) }));
    expect(s.agents.find((a) => a.id === "agt_a")!.balance).toBe("40.00");
  });

  it("adds agents from agent.created", () => {
    let s = loaded();
    s = applyEvent(s, ev("agent.created", { agentId: "agt_c", data: { agent: agent("agt_c", "worker-9") } }));
    expect(s.agents).toHaveLength(3);
  });
});

describe("reducer: misc actions", () => {
  it("summary replaces totals, agents and pending approvals", () => {
    let s = loaded();
    s = reducer(s, { type: "summary", summary: { ...summary, totalBalance: "41.00", pendingApprovals: [approval] } });
    expect(s.totals.totalBalance).toBe("41.00");
    expect(s.approvals).toHaveLength(1);
  });
  it("agent action upserts a single agent", () => {
    let s = loaded();
    s = reducer(s, { type: "agent", agent: { ...agent("agt_a", "naive-worker"), frozen: true, frozenReason: "by you" } });
    expect(s.agents.find((a) => a.id === "agt_a")!.frozen).toBe(true);
  });
  it("busy flags and details toggle", () => {
    let s = loaded();
    s = reducer(s, { type: "busyApproval", id: "apr_1", busy: true });
    expect(s.busyApprovals).toEqual(["apr_1"]);
    s = reducer(s, { type: "busyApproval", id: "apr_1", busy: false });
    expect(s.busyApprovals).toEqual([]);
    expect(reducer(s, { type: "toggleDetails" }).showDetails).toBe(true);
    expect(reducer(s, { type: "connection", status: "demo", offlineFallback: true }).offlineFallback).toBe(true);
  });
  it("knows which events move money", () => {
    expect(isMoneyEvent("payment.settled")).toBe(true);
    expect(isMoneyEvent("earning.received")).toBe(true);
    expect(isMoneyEvent("agent.frozen")).toBe(false);
    expect(isMoneyEvent("payment.needs_approval")).toBe(false);
  });
});

describe("collapseFeed (one line per payment)", () => {
  const ev = (id: string, type: WalletEvent["type"], extra: Partial<WalletEvent> = {}): WalletEvent => ({ id, type, at: "2026-10-17T12:00:00.000Z", message: id, ...extra });
  it("drops a signed row once its settlement is in the snapshot, and an Approve? row once decided", () => {
    const r = { id: "rcp_1" } as WalletEvent["receipt"];
    const out = collapseFeed([
      ev("e4", "approval.approved", { approval: { id: "apr_1" } as WalletEvent["approval"] }),
      ev("e3", "payment.settled", { receipt: r }),
      ev("e2", "payment.signed", { receipt: r }),
      ev("e1", "payment.needs_approval", { approval: { id: "apr_1" } as WalletEvent["approval"] }),
      ev("e0", "payment.needs_approval", { approval: { id: "apr_2" } as WalletEvent["approval"] }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["e4", "e3", "e0"]);
  });
});

