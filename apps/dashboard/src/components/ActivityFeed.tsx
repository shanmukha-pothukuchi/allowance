/**
 * The activity feed (docs/ui-rules.md D3): one Linear line per event. Avatar, "**researcher** paid
 * **Quantcomm Flood Research** · 5h ago", the amount right-aligned. A posted bank entry is a small
 * bank icon with a tooltip; only "posting" (a clock) and "not on statement" (words + Retry) show.
 */
import { bankNote, feedMarker } from "../bank";
import { shortHex } from "../format";
import { activityLine, eventAmount, shortAgo } from "../lines";
import type { WalletEvent } from "../types";
import { AgentAvatar } from "./Avatar";
import { Info } from "./Icons";
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
}

export function ActivityFeed({ events, pendingIds, showDetails, now, bankLinked = false, onRetryBank, retrying = [], checkingLast4 }: Props) {
  return (
    <ol className="ln-list feed-list">
      {events.length === 0 && <li className="empty">Waiting for the first payment&hellip;</li>}
      {events.map((e) => {
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
            line={activityLine(e, { pending, checkingLast4 })}
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
