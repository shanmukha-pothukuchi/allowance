/**
 * The brokerage and the scheduler (§20), polled: neither streams events to the wallet, and the
 * replay clock moves prices every few seconds. Fast while a view that shows them is open, slow
 * otherwise (the feed's "Rule woke researcher" lines and the sidebar's "Paused" mark need it).
 * Either service being down never touches the rest of the dashboard: its views say so, nothing else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, type WalletAdapter } from "./api/adapter";
import type { AgentRules, Portfolios, SchedulerState } from "./invest";
import type { AgentPublic } from "./types";

export type Loadable<T> = { state: "loading" } | { state: "ready"; data: T; at: number } | { state: "error"; message: string; data?: T };

export interface InvestState {
  portfolios: Loadable<Portfolios>;
  scheduler: Loadable<SchedulerState>;
  /** Schedule ids with a cancel in flight; "pause" while the switch is moving. */
  busy: string[];
}

export interface InvestActions {
  refresh(): void;
  cancel(id: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setRules(agent: Pick<AgentPublic, "id" | "name">, rules: AgentRules): Promise<void>;
}

const FAST_MS = 4000;
const SLOW_MS = 15000;

/** The service's own words when it answered with an error code; else that it isn't running. */
function downMessage(what: string, port: number, err: Error): string {
  if (err instanceof HttpError && err.code && err.code !== "not_found") return `The ${what} said: ${err.message}`;
  return `The ${what} isn't answering on port ${port}. Start it with npm run dev.`;
}

const failed = <T,>(prev: Loadable<T>, message: string): Loadable<T> => ({ state: "error", message, ...(prev.state === "ready" ? { data: prev.data } : prev.state === "error" && prev.data ? { data: prev.data } : {}) });

/** The data a Loadable holds, fresh or the last good one. */
export function dataOf<T>(l: Loadable<T>): T | undefined {
  return l.state === "ready" ? l.data : l.state === "error" ? l.data : undefined;
}

export function useInvest(adapter: WalletAdapter | null, fast: boolean): { invest: InvestState; investActions: InvestActions } {
  const [portfolios, setPortfolios] = useState<Loadable<Portfolios>>({ state: "loading" });
  const [scheduler, setScheduler] = useState<Loadable<SchedulerState>>({ state: "loading" });
  const [busy, setBusy] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const fastRef = useRef(fast);
  fastRef.current = fast;

  const load = useCallback(async () => {
    if (!adapter || inFlight.current) return;
    inFlight.current = true;
    try {
      await Promise.all([
        adapter.getPortfolios().then(
          (data) => setPortfolios({ state: "ready", data, at: Date.now() }),
          (err: Error) => setPortfolios((p) => failed(p, downMessage("brokerage", 4110, err))),
        ),
        adapter.getScheduler().then(
          (data) => setScheduler({ state: "ready", data, at: Date.now() }),
          (err: Error) => setScheduler((p) => failed(p, downMessage("scheduler", 4100, err))),
        ),
      ]);
    } finally {
      inFlight.current = false;
    }
  }, [adapter]);

  const loop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await load();
      loop();
    }, fastRef.current ? FAST_MS : SLOW_MS);
  }, [load]);

  useEffect(() => {
    if (!adapter) return;
    void load();
    loop();
    return () => clearTimeout(timer.current);
  }, [adapter, load, loop]);

  // Opening a view that shows these: fetch now, then poll fast.
  useEffect(() => {
    if (!adapter || !fast) return;
    void load();
    loop();
  }, [fast, adapter, load, loop]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const withBusy = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy((b) => [...b, key]);
      try {
        await fn();
      } finally {
        setBusy((b) => b.filter((x) => x !== key));
        void load();
      }
    },
    [load],
  );

  const investActions: InvestActions = {
    refresh,
    cancel: (id) =>
      withBusy(id, async () => {
        if (!adapter) return;
        await adapter.cancelSchedule(id);
        // Show it as done right away; the reload confirms.
        setScheduler((s) => (s.state === "ready" ? { ...s, data: { ...s.data, schedules: s.data.schedules.map((x) => (x.id === id ? { ...x, active: false } : x)) } } : s));
      }),
    setPaused: (paused) =>
      withBusy("pause", async () => {
        if (!adapter) return;
        const now = await adapter.setPaused(paused);
        setScheduler((s) => (s.state === "ready" ? { ...s, data: { ...s.data, paused: now } } : s));
      }),
    setRules: async (agent, rules) => {
      if (!adapter) return;
      await adapter.setRules(agent, rules);
      void load();
    },
  };

  return { invest: { portfolios, scheduler, busy }, investActions };
}
