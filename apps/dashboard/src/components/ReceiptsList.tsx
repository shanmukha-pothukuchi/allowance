/** The Receipts tab, and the receipt rows the bank and agent sheets reuse: the same line rules as the feed. */
import { bankMarker, bankNote } from "../bank";
import { shortHex } from "../format";
import { receiptAmount, receiptLine, shortAgo } from "../lines";
import type { Receipt } from "../types";
import { AgentAvatar } from "./Avatar";
import { BankIcon, BankLine, BankProblem, LineRow } from "./Lines";

interface Props {
  receipts: Receipt[];
  showDetails: boolean;
  now: number;
  /** A Capital One account is linked (§16): blocked payments say they never reached it. */
  bankLinked?: boolean;
  /** Retry one receipt's posting (`POST /v1/bank/retry { receiptId }`). */
  onRetryBank?(receiptId: string): void;
  /** Receipt ids with a retry in flight ("*": all of them). */
  retrying?: string[];
  /** The owner's checking (top-ups come from it). */
  checkingLast4?: string;
}

interface RowProps {
  r: Receipt;
  now: number;
  bankLinked: boolean;
  showDetails?: boolean;
  /** In one agent's sheet the avatar would only repeat the header. */
  hideAgent?: boolean;
  onRetry?(): void;
  busy?: boolean;
  checkingLast4?: string;
  /** Detail views (an agent, the bank): the bank's part in words instead of an icon. */
  bankText?: boolean;
}

export function ReceiptRow({ r, now, bankLinked, showDetails = false, hideAgent = false, onRetry, busy = false, checkingLast4, bankText = false }: RowProps) {
  const mark = bankMarker(r, bankLinked);
  const note = mark ? bankNote(r, checkingLast4) : null;
  const full = receiptLine(r, { checkingLast4 });
  // In detail views the bank line says where a top-up came from; the sentence doesn't repeat it.
  const line = bankText && r.kind === "topup" && note ? { ...full, tail: "" } : full;
  return (
    <LineRow
      lead={hideAgent ? null : <AgentAvatar name={r.agentName} size="xs" />}
      className={hideAgent ? "ln-row-nolead" : ""}
      line={hideAgent ? { ...line, actor: undefined, verb: line.verb.replace(/^./, (c) => c.toUpperCase()) } : line}
      time={shortAgo(r.createdAt, now)}
      dateTime={r.createdAt}
      amount={receiptAmount(r)}
      amountTitle={mark?.tone === "stopped" ? mark.text : undefined}
      marks={bankText ? null : <BankIcon marker={mark} note={note} />}
    >
      {bankText && mark?.tone !== "failed" && <BankLine note={note} />}
      <BankProblem marker={mark} onRetry={onRetry} busy={busy} />
      {showDetails && (
        <p className="ln-details">
          <code title={r.counterparty.address}>{shortHex(r.counterparty.address, 8, 6)}</code>
          {r.txHash &&
            (r.explorerUrl ? (
              <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                tx {shortHex(r.txHash, 8, 6)}
              </a>
            ) : (
              <code>tx {shortHex(r.txHash, 8, 6)}</code>
            ))}
          <code>{r.id}</code>
        </p>
      )}
    </LineRow>
  );
}

export function ReceiptsList({ receipts, showDetails, now, bankLinked = false, onRetryBank, retrying = [], checkingLast4 }: Props) {
  if (receipts.length === 0) return <p className="empty">No receipts yet.</p>;
  return (
    <ul className="ln-list receipt-list">
      {receipts.map((r) => (
        <ReceiptRow
          key={r.id}
          r={r}
          now={now}
          bankLinked={bankLinked}
          showDetails={showDetails}
          checkingLast4={checkingLast4}
          onRetry={onRetryBank && (() => onRetryBank(r.id))}
          busy={retrying.includes(r.id) || retrying.includes("*")}
        />
      ))}
    </ul>
  );
}
