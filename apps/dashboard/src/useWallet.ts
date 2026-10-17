/**
 * The one stateful hook. Picks an adapter, loads the initial snapshot, subscribes to
 * live events, and exposes owner actions. Components stay thin.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { mockRequested, type WalletAdapter } from "./api/adapter";
import { createHttpAdapter, walletServiceReachable } from "./api/httpAdapter";
import { createMockAdapter } from "./api/mockAdapter";
import { initialState, isMoneyEvent, reducer, type DashboardState } from "./state";
import type { ConnectionStatus, WalletEvent } from "./types";

export interface WalletActions {
  approve(id: string): Promise<void>;
  deny(id: string): Promise<void>;
  freeze(agentId: string): Promise<void>;
  unfreeze(agentId: string): Promise<void>;
  topup(agentId: string, amount?: string): Promise<void>;
  toggleDetails(): void;
}

const SUMMARY_DEBOUNCE_MS = 500;

export function useWallet(): { state: DashboardState; actions: WalletActions } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const adapterRef = useRef<WalletAdapter | null>(null);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refetchSummary = useCallback(() => {
    clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(async () => {
      const a = adapterRef.current;
      if (!a) return;
      try {
        dispatch({ type: "summary", summary: await a.getSummary() });
      } catch (err) {
        console.warn("[dashboard] summary refetch failed", err);
      }
    }, SUMMARY_DEBOUNCE_MS);
  }, []);

  const loadAll = useCallback(async (a: WalletAdapter) => {
    const [summary, events, receipts, approvals] = await Promise.all([
      a.getSummary(),
      a.getRecentEvents(100),
      a.getReceipts(50),
      a.getPendingApprovals(),
    ]);
    dispatch({ type: "loaded", summary, events, receipts, approvals });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      let adapter: WalletAdapter;
      let fallback = false;
      if (mockRequested()) {
        adapter = createMockAdapter();
      } else if (await walletServiceReachable()) {
        adapter = createHttpAdapter();
      } else {
        adapter = createMockAdapter();
        fallback = true;
      }
      if (cancelled) return;
      adapterRef.current = adapter;
      if (adapter.kind === "mock") dispatch({ type: "connection", status: "demo", offlineFallback: fallback });

      try {
        await loadAll(adapter);
      } catch (err) {
        dispatch({ type: "error", message: `Could not load wallet data: ${(err as Error).message}` });
      }
      if (cancelled) return;

      let wasLive = false;
      const onEvent = (e: WalletEvent) => {
        dispatch({ type: "event", event: e });
        if (isMoneyEvent(e.type)) refetchSummary();
      };
      const onStatus = (s: ConnectionStatus) => {
        if (adapter.kind === "mock") return; // stays "demo"
        dispatch({ type: "connection", status: s });
        // After a reconnect we may have missed events: reload the snapshot.
        if (s === "live" && wasLive) void loadAll(adapter).catch(() => undefined);
        if (s === "live") wasLive = true;
      };
      unsubscribe = adapter.subscribe(onEvent, onStatus);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      clearTimeout(summaryTimer.current);
    };
  }, [loadAll, refetchSummary]);

  const run = useCallback(
    async (busy: { type: "busyApproval" | "busyAgent"; id: string }, fn: (a: WalletAdapter) => Promise<unknown>) => {
      const a = adapterRef.current;
      if (!a) return;
      dispatch({ ...busy, busy: true });
      try {
        await fn(a);
        dispatch({ type: "error", message: undefined });
      } catch (err) {
        dispatch({ type: "error", message: (err as Error).message });
      } finally {
        dispatch({ ...busy, busy: false });
        refetchSummary();
      }
    },
    [refetchSummary],
  );

  const actions: WalletActions = {
    approve: (id) => run({ type: "busyApproval", id }, (a) => a.approve(id)),
    deny: (id) => run({ type: "busyApproval", id }, (a) => a.deny(id)),
    freeze: (id) => run({ type: "busyAgent", id }, async (a) => dispatch({ type: "agent", agent: await a.freeze(id) })),
    unfreeze: (id) => run({ type: "busyAgent", id }, async (a) => dispatch({ type: "agent", agent: await a.unfreeze(id) })),
    topup: (id, amount = "20.00") => run({ type: "busyAgent", id }, (a) => a.topup(id, amount)),
    toggleDetails: () => dispatch({ type: "toggleDetails" }),
  };

  return { state, actions };
}

/** Re-renders once a second so relative times stay fresh. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
