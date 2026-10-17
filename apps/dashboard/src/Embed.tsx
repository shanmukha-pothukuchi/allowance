/**
 * `/?approval=<id>&embed=1`: one approval card and nothing else, for the agent chat to iframe
 * (§13.5). Same origin as the dashboard, so its requests carry the owner key via the dev proxy;
 * the chat page never does. Posts its height and the final status to the parent window.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { mockRequested, type WalletAdapter } from "./api/adapter";
import { createHttpAdapter, walletServiceReachable } from "./api/httpAdapter";
import { createMockAdapter, type MockAdapter } from "./api/mockAdapter";
import { ApprovalCard } from "./components/ApprovalCard";
import { Lock } from "./components/Icons";
import { announceableStatus, postToParent, sizeMessage, statusMessage, type EmbedStatus } from "./embed";
import type { Approval, WalletEvent } from "./types";
import { useNow } from "./useWallet";

type Phase = "loading" | "offline" | "not_found" | "ready";

function sameApproval(e: WalletEvent, id: string) {
  return e.approval?.id === id || e.receipt?.approvalId === id;
}

export function EmbedApproval({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const adapterRef = useRef<WalletAdapter | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const announced = useRef<string | null>(null);
  const now = useNow(1000);

  const load = useCallback(
    async (a: WalletAdapter) => {
      try {
        const found = await a.getApproval(id);
        if (found) {
          setApproval(found);
          setPhase("ready");
        } else setPhase("not_found");
      } catch (err) {
        setError(`Could not load this approval: ${(err as Error).message}`);
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      let adapter: WalletAdapter;
      if (mockRequested()) adapter = createMockAdapter();
      else {
        // Never a mock fallback here either: an embed that approves fake data would be worse.
        while (!(await walletServiceReachable())) {
          if (cancelled) return;
          setPhase("offline");
          await new Promise((r) => setTimeout(r, 2000));
        }
        adapter = createHttpAdapter();
      }
      if (cancelled) return;
      adapterRef.current = adapter;
      await load(adapter);
      if (cancelled) return;
      let wasLive = false;
      unsubscribe = adapter.subscribe(
        (e) => {
          if (!sameApproval(e, id)) return;
          if (e.type !== "approval.approved" && e.type !== "approval.denied") return;
          // Decided elsewhere (Telegram, the dashboard): show it and tell the chat.
          setApproval((prev) => {
            const base = e.approval ?? prev;
            if (!base) return prev;
            const status = e.approval?.status ?? (e.type === "approval.approved" ? "approved" : e.reason === "expired" ? "expired" : "denied");
            return { ...(prev ?? base), ...base, status };
          });
          setPhase("ready");
        },
        (s) => {
          if (s === "live" && wasLive) void load(adapter); // may have missed the decision
          if (s === "live") wasLive = true;
        },
      );
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      const a = adapterRef.current as MockAdapter | null;
      if (a?.kind === "mock") a.stop();
    };
  }, [id, load]);

  // Height: on load and on every resize, so the chat can size the iframe to the card.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const send = () => postToParent(sizeMessage(id, el.getBoundingClientRect().height));
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);

  // Final status, once per status (decided here, elsewhere, or already decided on load).
  const status: EmbedStatus | undefined = phase === "not_found" ? "not_found" : approval?.status;
  useEffect(() => {
    const s = announceableStatus(status);
    if (s && announced.current !== s) {
      announced.current = s;
      postToParent(statusMessage(id, s));
    }
  }, [id, status]);

  const decide = async (kind: "approve" | "deny") => {
    const a = adapterRef.current;
    if (!a) return;
    setBusy(true);
    setError(undefined);
    try {
      setApproval(await a[kind](id));
    } catch (err) {
      setError((err as Error).message);
      await load(a); // most likely decided elsewhere a moment ago; show what happened
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="embed" ref={rootRef}>
      {phase === "ready" && approval && (
        <ApprovalCard approval={approval} now={now} busy={busy} variant="embed" onApprove={() => void decide("approve")} onDeny={() => void decide("deny")} />
      )}
      {phase === "loading" && <div className="embed-note">Loading approval…</div>}
      {phase === "offline" && <div className="embed-note embed-warn">Can't reach the wallet. Approve on your phone or the dashboard.</div>}
      {phase === "not_found" && <div className="embed-note">This approval was not found. It may belong to a wallet that was reset.</div>}
      {error && <p className="embed-error" role="alert">{error}</p>}
      <p className="embed-foot">
        <Lock width={13} height={13} /> Allowance wallet · only you can approve
      </p>
    </div>
  );
}
