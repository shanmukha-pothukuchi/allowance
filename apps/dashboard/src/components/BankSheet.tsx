/**
 * The bank (§16.5, `/?sheet=bank`, also `&embed=1`): the owner's Capital One checking, every
 * agent's allowance account with its balance, and recent receipts as the bank sees them. In the
 * dashboard it reads the live state; embedded it fetches for itself and polls.
 */
import { useCallback, useEffect, useState } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { isBankEvent, masked, queueLine, SANDBOX_NOTE } from "../bank";
import { money } from "../format";
import { shortAgo } from "../lines";
import { isMoneyEvent } from "../state";
import type { BankSummary, Receipt } from "../types";
import { useNow } from "../useWallet";
import { AgentAvatar } from "./Avatar";
import { BankTile } from "./BankParts";
import { Chevron } from "./Icons";
import { ReceiptRow } from "./ReceiptsList";
import { Field, SheetShell } from "./SheetParts";

interface Props {
  adapter: WalletAdapter | null;
  offline?: boolean;
  embed: boolean;
  /** Live data from the dashboard. Omitted (embed): the sheet loads and polls on its own. */
  bank?: BankSummary | null;
  receipts?: Receipt[];
  onClose(): void;
  /** Dashboard only: open an agent's detail from its account row. */
  onOpenAgent?(name: string): void;
  /** Dashboard: the shared retry (updates the feed too). Omitted: the sheet calls the wallet itself. */
  onRetry?(receiptId?: string): Promise<void>;
  /** Dashboard: the bank was just linked; refetch the summary. */
  onChanged?(): void;
}

/** What a wallet without a bank (no Nessie key, or no /v1/bank at all) looks like. */
const NO_BANK: BankSummary = { enabled: false, linked: false, provider: "Capital One", sandbox: "Nessie", accounts: [], queue: { pending: 0, failed: 0 }, updatedAt: new Date(0).toISOString() };

/** Embedded, the sheet follows the wallet's events; the poll only covers a dropped stream. */
const POLL_MS = 10_000;
const EVENT_DEBOUNCE_MS = 700;

export function BankSheet({ adapter, offline = false, embed, bank: liveBank, receipts: liveReceipts, onClose, onOpenAgent, onRetry, onChanged }: Props) {
  const live = liveBank !== undefined;
  const [own, setOwn] = useState<{ bank: BankSummary | null; receipts: Receipt[] } | null>(null);
  const [loadError, setLoadError] = useState<string>();
  // "link", "*" (retry all), or the receipt id being retried.
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>();
  const now = useNow(5000);

  const load = useCallback(async (a: WalletAdapter) => {
    try {
      const [bank, receipts] = await Promise.all([
        a.getBank().catch((err) => {
          if (err instanceof HttpError && err.status === 404) return NO_BANK; // a wallet that predates §16
          throw err;
        }),
        a.getReceipts(50),
      ]);
      setOwn({ bank, receipts });
      setLoadError(undefined);
    } catch (err) {
      setLoadError(`Could not load the bank: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    if (!adapter) return;
    // In the dashboard the bank comes from live state; still load once if it hasn't arrived yet.
    if (live && liveBank) return;
    void load(adapter);
    if (live) return;
    const t = setInterval(() => void load(adapter), POLL_MS);
    let soon: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = adapter.subscribe((e) => {
      if (!isBankEvent(e.type) && !isMoneyEvent(e.type)) return;
      clearTimeout(soon);
      soon = setTimeout(() => void load(adapter), EVENT_DEBOUNCE_MS);
    });
    return () => {
      clearInterval(t);
      clearTimeout(soon);
      unsubscribe();
    };
  }, [adapter, live, liveBank, load]);

  // Just linked here: show what the wallet answered until the dashboard's state catches up.
  const bank = (live && !(own?.bank?.linked && !liveBank?.linked) ? liveBank : null) ?? own?.bank ?? null;
  const receipts = (live ? liveReceipts : own?.receipts) ?? own?.receipts ?? [];
  // What needs the owner (not on the statement) first, then the newest.
  const activity = [...receipts.filter((r) => r.bank?.status === "failed"), ...receipts.filter((r) => r.bank && r.bank.status !== "failed")].slice(0, 8);
  const queue = queueLine(bank?.queue);

  const retry = async (receiptId?: string) => {
    if (!adapter) return;
    setBusy(receiptId ?? "*");
    setNote(undefined);
    try {
      if (onRetry) await onRetry(receiptId);
      else {
        const { queued } = await adapter.retryBank(receiptId);
        setNote(queued ? `Asked Capital One to post ${queued === 1 ? "it" : `${queued} entries`} again.` : "Nothing to retry.");
      }
      await load(adapter);
    } catch (err) {
      setNote(`Retry failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const link = async () => {
    if (!adapter) return;
    setBusy("link");
    setNote(undefined);
    try {
      setOwn({ bank: await adapter.linkBank(), receipts });
      onChanged?.();
    } catch (err) {
      setNote(`Couldn't link Capital One: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const head = (
    <div className="osheet-title">
      <BankTile size="sm" />
      <div className="osheet-titles">
        <h2 className="osheet-name">Capital One</h2>
        <p className="osheet-sub">Nessie sandbox{bank?.linked ? ` · as of ${shortAgo(bank.updatedAt, now)}` : ""}</p>
      </div>
    </div>
  );

  return (
    <SheetShell embed={embed} label="Capital One bank" head={head} onClose={onClose}>
      {offline && !adapter && <div className="osheet-banner banner-offline">Can't reach the wallet. Start it with npm run dev. Retrying…</div>}
      {loadError && <div className="osheet-banner banner-offline">{loadError}</div>}
      {adapter && !bank && !loadError && <p className="muted">Loading…</p>}

      {bank && !bank.enabled && <p className="muted">No bank is connected. Put a Nessie key in .env as NESSIE_API_KEY and restart the wallet to put Capital One behind Allowance.</p>}

      {bank?.enabled && !bank.linked && (
        <div className="osheet-row-action">
          <span>Capital One isn't linked yet.</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void link()} disabled={busy === "link"}>
            {busy === "link" ? "Linking…" : "Link Capital One"}
          </button>
        </div>
      )}

      {bank?.error && <div className="osheet-banner bank-error">{bank.error}</div>}

      {bank?.linked && bank.checking && (
        <Field label="Checking">
          <ul className="ln-group">
            <li className="grow">
              <span className="grow-main">
                <span className="grow-title">
                  Checking {masked(bank.checking.last4)}
                  {bank.checking.nickname && <span className="grow-meta"> · {bank.checking.nickname}</span>}
                </span>
                <span className="grow-meta">Funds every agent's allowance account</span>
              </span>
              <span className="grow-end grow-amt">{money(bank.checking.balance)}</span>
            </li>
          </ul>
        </Field>
      )}

      {bank?.linked && (
        <Field label="Allowance accounts" aside={bank.accounts.length || undefined}>
          {bank.accounts.length === 0 ? (
            <p className="muted">None yet. An agent gets its account the first time its money moves.</p>
          ) : (
            <ul className="ln-group">
              {bank.accounts.map((a) => {
                const inner = (
                  <>
                    <AgentAvatar name={a.agentName} size="xs" />
                    <span className="grow-main">
                      <span className="grow-title">
                        {a.agentName} <span className="grow-meta">{masked(a.last4)}</span>
                      </span>
                    </span>
                    <span className="grow-end grow-amt">{money(a.balance)}</span>
                    {onOpenAgent && <Chevron width={14} height={14} className="grow-chev" />}
                  </>
                );
                return (
                  <li key={a.agentId}>
                    {onOpenAgent ? (
                      <button type="button" className="grow grow-btn" onClick={() => onOpenAgent(a.agentName)} title={`${a.agentName}'s statement`}>
                        {inner}
                      </button>
                    ) : (
                      <div className="grow">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Field>
      )}

      {bank?.linked && (
        <Field
          label="Recent activity"
          aside={
            queue ? (
              <span className="bank-queue">
                {queue}
                {bank.queue.failed > 0 && (
                  <button type="button" className="ln-retry" onClick={() => void retry()} disabled={busy === "*"}>
                    {busy === "*" ? "Retrying…" : bank.queue.failed > 1 ? "Retry all" : "Retry"}
                  </button>
                )}
              </span>
            ) : undefined
          }
        >
          {note && (
            <p className="muted bank-note" role="status">
              {note}
            </p>
          )}
          {activity.length === 0 ? (
            <p className="muted">Nothing yet. Payments, earnings and top-ups land here as they reach Capital One.</p>
          ) : (
            <ul className="ln-list ln-group">
              {activity.map((r) => (
                <ReceiptRow key={r.id} r={r} now={now} bankLinked bankText checkingLast4={bank.checking?.last4} onRetry={() => void retry(r.id)} busy={busy === r.id || busy === "*"} />
              ))}
            </ul>
          )}
        </Field>
      )}

      {bank?.enabled && <p className="osheet-note">{SANDBOX_NOTE} USDC still does the paying; each payment shows on the agent's statement under the merchant's name.</p>}
    </SheetShell>
  );
}
