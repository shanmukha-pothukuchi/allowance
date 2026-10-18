/**
 * The one stateful hook. Picks an adapter, loads the initial snapshot, subscribes to
 * live events, and exposes owner actions. Components stay thin.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { mockRequested, type WalletAdapter } from "./api/adapter";
import { createHttpAdapter, walletServiceReachable } from "./api/httpAdapter";
import { createMockAdapter, mockChainMode } from "./api/mockAdapter";
import { initialState, reducer, refreshesSummary, serviceKey, type DashboardState } from "./state";
import type { ConnectionStatus, WalletEvent } from "./types";

export interface WalletActions {
  approve(id: string): Promise<void>;
  deny(id: string): Promise<void>;
  freeze(agentId: string): Promise<void>;
  unfreeze(agentId: string): Promise<void>;
  topup(agentId: string, amount?: string): Promise<void>;
  connectService(agentId: string, serviceId: string): Promise<void>;
  disconnectService(agentId: string, serviceId: string): Promise<void>;
  /** Fetch usage docs for the detail sheet (once per service). */
  loadServiceDocs(serviceId: string): Promise<void>;
  reloadDirectory(): Promise<void>;
  /** Refetch the summary soon (after a sheet created an agent or added money). */
  refresh(): void;
  toggleDetails(): void;
}

const SUMMARY_DEBOUNCE_MS = 500;

export function useWallet(): { state: DashboardState; actions: WalletActions; adapter: WalletAdapter | null } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const adapterRef = useRef<WalletAdapter | null>(null);
  // The same adapter the dashboard uses, for the owner sheets (so the mock's new agents show up here).
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const docsRequested = useRef(new Set<string>());

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

  const loadDirectory = useCallback(async (a: WalletAdapter) => {
    dispatch({ type: "directoryLoading" });
    try {
      dispatch({ type: "directory", services: await a.getDirectory() });
    } catch (err) {
      dispatch({ type: "directoryError", message: `Could not load the service directory: ${(err as Error).message}` });
    }
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
      if (mockRequested()) {
        // Only on explicit request (?mock=1). Never a silent fallback: fake activity on the
        // owner's screen would be worse than an honest "offline".
        adapter = createMockAdapter({ chainMode: mockChainMode() });
      } else {
        while (!(await walletServiceReachable())) {
          if (cancelled) return;
          dispatch({ type: "connection", status: "offline" });
          await new Promise((r) => setTimeout(r, 2000));
        }
        adapter = createHttpAdapter();
      }
      if (cancelled) return;
      adapterRef.current = adapter;
      setAdapter(adapter);
      if (adapter.kind === "mock") dispatch({ type: "connection", status: "demo" });

      try {
        await loadAll(adapter);
      } catch (err) {
        dispatch({ type: "error", message: `Could not load wallet data: ${(err as Error).message}` });
      }
      if (cancelled) return;
      // The directory is a separate service behind the wallet; it failing never blocks the overview.
      void loadDirectory(adapter);

      let wasLive = false;
      const onEvent = (e: WalletEvent) => {
        dispatch({ type: "event", event: e });
        if (refreshesSummary(e.type)) refetchSummary();
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
  }, [loadAll, loadDirectory, refetchSummary]);

  const run = useCallback(
    async (busy: { type: "busyApproval" | "busyAgent"; id: string } | { type: "busyService"; key: string }, fn: (a: WalletAdapter) => Promise<unknown>) => {
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
    connectService: (agentId, serviceId) =>
      run({ type: "busyService", key: serviceKey(agentId, serviceId) }, async (a) => dispatch({ type: "agent", agent: await a.connectService(agentId, serviceId) })),
    disconnectService: (agentId, serviceId) =>
      run({ type: "busyService", key: serviceKey(agentId, serviceId) }, async (a) => dispatch({ type: "agent", agent: await a.disconnectService(agentId, serviceId) })),
    loadServiceDocs: async (serviceId) => {
      const a = adapterRef.current;
      if (!a || docsRequested.current.has(serviceId)) return;
      docsRequested.current.add(serviceId);
      try {
        const svc = await a.getService(serviceId);
        dispatch({ type: "serviceDocs", id: serviceId, docs: svc.docs ?? "" });
      } catch {
        docsRequested.current.delete(serviceId); // custom services may have no directory entry
        dispatch({ type: "serviceDocs", id: serviceId, docs: "" });
      }
    },
    reloadDirectory: async () => {
      if (adapterRef.current) await loadDirectory(adapterRef.current);
    },
    refresh: () => refetchSummary(),
    toggleDetails: () => dispatch({ type: "toggleDetails" }),
  };

  return { state, actions, adapter };
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
