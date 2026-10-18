/**
 * An adapter for a page that is not the dashboard (the embedded sheets): the mock only on explicit
 * request, else the wallet-service once it answers. Never a silent mock fallback (§12).
 */
import { useEffect, useState } from "react";
import { mockRequested, type WalletAdapter } from "./api/adapter";
import { createHttpAdapter, walletServiceReachable } from "./api/httpAdapter";
import { createMockAdapter, mockChainMode, type MockAdapter } from "./api/mockAdapter";

export function useStandaloneAdapter(): { adapter: WalletAdapter | null; offline: boolean } {
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let made: WalletAdapter | null = null;
    (async () => {
      if (mockRequested()) made = createMockAdapter({ chainMode: mockChainMode() });
      else {
        while (!(await walletServiceReachable())) {
          if (cancelled) return;
          setOffline(true);
          await new Promise((r) => setTimeout(r, 2000));
        }
        made = createHttpAdapter();
      }
      if (cancelled) return;
      setOffline(false);
      setAdapter(made);
    })();
    return () => {
      cancelled = true;
      if (made?.kind === "mock") (made as MockAdapter).stop();
    };
  }, []);
  return { adapter, offline };
}
