/**
 * The activity feed (docs/ui-rules.md D3): one Linear line per event. Avatar, "**researcher** paid
 * **Quantcomm Flood Research** · 5h ago", the amount right-aligned. A posted bank entry is a small
 * bank icon with a tooltip; only "posting" (a clock) and "not on statement" (words + Retry) show.
 */
import { bankNote, feedMarker } from "../bank";
import { shortHex } from "../format";
import { firingLine, type Firing, type Order } from "../invest";
import { activityLine, eventAmount, shortAgo } from "../lines";
import type { WalletEvent } from "../types";
import { AgentAvatar } from "./Avatar";
import { Alarm, Chart, Info } from "./Icons";
import { BankIcon, BankProblem, LineRow } from "./Lines";

interface Props {
  events: WalletEvent[];
  /** Approvals still open: their ask rows carry a "Pending" mark (the card above decides them). */
  pendingIds: Set<string>;
  showDetails: boolean;
  now: number;
  /** A Capital One account is linked (§16): rows carry their statement marker. */
  bankLinked?: boolean;
  onRetryBank?(receiptId: string): void;
  /** Receipt ids with a retry in flight ("*": all of them). */
  retrying?: string[];
  /** The owner's checking (top-ups come from it). */
  checkingLast4?: string;
  /** §20.3: times a schedule woke an agent. They come from the scheduler, not the wallet, and interleave by time. */
  firings?: Firing[];
  /** §20.1 orders by tx hash: a trade's line names its shares and P/L. */
  orders?: Map<string, Order>;
}

type FeedItem = { kind: "event"; at: number; e: WalletEvent } | { kind: "firing"; at: number; f: Firing };

/** Wallet events and firings, newest first. Firings older than the oldest event shown are left out. */
function merge(events: WalletEvent[], firings: Firing[]): FeedItem[] {
  const ev: FeedItem[] = events.map((e) => ({ kind: "event", at: Date.parse(e.at), e }));
  if (!firings.length) return ev;
  const floor = events.length >= 50 ? Date.parse(events[events.length - 1].at) : 0;
  const fi: FeedItem[] = firings.filter((f) => Date.parse(f.at) >= floor).map((f) => ({ kind: "firing", at: Date.parse(f.at), f }));
  return [...ev, ...fi].sort((a, b) => b.at - a.at);
}

export function ActivityFeed({ events, pendingIds, showDetails, now, bankLinked = false, onRetryBank, retrying = [], checkingLast4, firings = [], orders }: Props) {
  const items = merge(events, firings);
  return (
    <ol className="ln-list feed-list">
      {items.length === 0 && <li className="empty">Waiting for the first payment&hellip;</li>}
      {items.map((it) => {
        if (it.kind === "firing") {
          const f = it.f;
          const rule = f.source === "owner" || !!f.rule;
          return (
            <LineRow
              key={`fire:${f.id}`}
              className="feed-row"
              lead={
                <span className="ln-icon" title={rule ? "Your rule" : "A schedule the agent set"}>
                  {rule ? <Chart width={12} height={12} /> : <Alarm width={12} height={12} />}
                </span>
              }
              line={firingLine(f)}
              time={shortAgo(f.at, now)}
              dateTime={f.at}
            >
              {showDetails && f.context && <p className="ln-details">{f.context}</p>}
            </LineRow>
          );
        }
        const e = it.e;
        const approvalId = e.approval?.id;
        const asks = e.type === "payment.needs_approval" || e.type === "service.requested";
        const pending = asks && !!approvalId && pendingIds.has(approvalId);
        const mark = feedMarker(e, bankLinked);
        const r = e.receipt;
        // Rows are keyed by event id and mount once, so the CSS entry animation runs exactly once.
        return (
          <LineRow
            key={e.id}
            className="feed-row"
            lead={e.agentName ? <AgentAvatar name={e.agentName} size="xs" /> : <span className="ln-icon"><Info width={13} height={13} /></span>}
            line={activityLine(e, { pending, checkingLast4, orders })}
            time={shortAgo(e.at, now)}
            dateTime={e.at}
            amount={eventAmount(e)}
            amountTitle={mark?.tone === "stopped" ? mark.text : undefined}
            marks={<BankIcon marker={mark} note={r && mark ? bankNote(r, checkingLast4) : null} />}
          >
            {r && <BankProblem marker={mark} onRetry={onRetryBank && (() => onRetryBank(r.id))} busy={retrying.includes(r.id) || retrying.includes("*")} />}
            {showDetails && r && (r.txHash || r.counterparty.address) && (
              <p className="ln-details">
                {r.txHash &&
                  (r.explorerUrl ? (
                    <a className="hash" href={r.explorerUrl} target="_blank" rel="noreferrer">
                      tx {shortHex(r.txHash, 8, 6)}
                    </a>
                  ) : (
                    <code className="hash">tx {shortHex(r.txHash, 8, 6)}</code>
                  ))}
                {r.counterparty.address && <code className="hash">to {shortHex(r.counterparty.address, 8, 6)}</code>}
              </p>
            )}
          </LineRow>
        );
      })}
    </ol>
  );
}
