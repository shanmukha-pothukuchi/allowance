/**
 * The one stateful hook. Picks an adapter, loads the initial snapshot, subscribes to
 * live events, and exposes owner actions. Components stay thin.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { mockRequested, type WalletAdapter } from "./api/adapter";
import { createHttpAdapter, walletServiceReachable } from "./api/httpAdapter";
import { createMockAdapter, mockBankMode, mockChainMode } from "./api/mockAdapter";
import { isBankEvent } from "./bank";
import { serviceIdOfEvent } from "./format";
import { initialState, isMoneyEvent, reducer, refreshesSummary, serviceKey, type DashboardState } from "./state";
import type { ConnectionStatus, DirectoryService, WalletEvent } from "./types";

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
  /** The owner added a service (a Shopify store): show it now, then reload the directory and balances. */
  serviceAdded(service: DirectoryService): void;
  /** Refetch the summary soon (after a sheet created an agent or added money). */
  refresh(): void;
  /** `POST /v1/bank/retry`: post that receipt (or every "Not on statement" one) again (§16.4). */
  retryBank(receiptId?: string): Promise<void>;
  toggleDetails(): void;
}

const SUMMARY_DEBOUNCE_MS = 500;
/** Nessie balances are cached 10 s by the wallet; no point asking more often than every second or so. */
const BANK_DEBOUNCE_MS = 1200;

export function useWallet(): { state: DashboardState; actions: WalletActions; adapter: WalletAdapter | null } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const adapterRef = useRef<WalletAdapter | null>(null);
  // The same adapter the dashboard uses, for the owner sheets (so the mock's new agents show up here).
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bankTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The wallet has a bank (its summary carries `bank`): only then is /v1/bank ever asked (§16.4).
  const bankOn = useRef(false);
  const docsRequested = useRef(new Set<string>());
  // Directory ids we know, so a connection to a new entry (an approved Shopify store) reloads it.
  const knownIds = useRef(new Set<string>());
  useEffect(() => {
    knownIds.current = new Set(state.directory.map((s) => s.id));
  }, [state.directory]);

  const loadBank = useCallback(async (a: WalletAdapter) => {
    try {
      dispatch({ type: "bank", bank: await a.getBank() });
    } catch (err) {
      // An older wallet without /v1/bank, or a hiccup: keep what we have (the summary still shows checking).
      console.warn("[dashboard] bank refetch failed", err);
    }
  }, []);

  const refetchBank = useCallback(() => {
    if (!bankOn.current) return;
    clearTimeout(bankTimer.current);
    bankTimer.current = setTimeout(() => {
      if (adapterRef.current) void loadBank(adapterRef.current);
    }, BANK_DEBOUNCE_MS);
  }, [loadBank]);

  const refetchSummary = useCallback(() => {
    clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(async () => {
      const a = adapterRef.current;
      if (!a) return;
      try {
        const summary = await a.getSummary();
        dispatch({ type: "summary", summary });
        const had = bankOn.current;
        bankOn.current = !!summary.bank;
        if (bankOn.current) refetchBank();
        else if (had) dispatch({ type: "bank", bank: null });
      } catch (err) {
        console.warn("[dashboard] summary refetch failed", err);
      }
    }, SUMMARY_DEBOUNCE_MS);
  }, [refetchBank]);

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
    bankOn.current = !!summary.bank;
    if (bankOn.current) await loadBank(a);
  }, [loadBank]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      let adapter: WalletAdapter;
      if (mockRequested()) {
        // Only on explicit request (?mock=1). Never a silent fallback: fake activity on the
        // owner's screen would be worse than an honest "offline".
        adapter = createMockAdapter({ chainMode: mockChainMode(), bank: mockBankMode() });
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
        if (isBankEvent(e.type) || isMoneyEvent(e.type) || e.type === "agent.created") refetchBank();
        // §15.3: approving an agent's Shopify store adds it to the directory first.
        const sid = e.type === "service.connected" ? serviceIdOfEvent(e) : undefined;
        if (sid && knownIds.current.size && !knownIds.current.has(sid)) {
          knownIds.current.add(sid);
          void loadDirectory(adapter);
        }
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
      clearTimeout(bankTimer.current);
    };
  }, [loadAll, loadDirectory, refetchSummary, refetchBank]);

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
    retryBank: async (receiptId) => {
      const a = adapterRef.current;
      if (!a) return;
      try {
        await a.retryBank(receiptId);
        dispatch({ type: "bankRetried", receiptId });
        dispatch({ type: "error", message: undefined });
      } catch (err) {
        dispatch({ type: "error", message: `Capital One retry failed: ${(err as Error).message}` });
      } finally {
        refetchBank();
      }
    },
    serviceAdded: (service) => {
      dispatch({ type: "directoryUpsert", service });
      knownIds.current.add(service.id);
      if (adapterRef.current) void loadDirectory(adapterRef.current);
      refetchSummary();
    },
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
