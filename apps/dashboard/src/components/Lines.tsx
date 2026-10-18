/**
 * The one row every list of events uses (feed, receipts, bank activity, an agent's receipts): a
 * small avatar or icon, "**actor** verb **object** · 5h ago", then the marks and the amount on the
 * right in tabular figures. Problems get a second, worded line; the normal state stays quiet.
 */
import type { ReactNode } from "react";
import type { BankMarker } from "../bank";
import type { AmountCell, Line, LineStatus } from "../lines";
import { Bank, Clock, Warn } from "./Icons";

export function LineText({ line, time, dateTime }: { line: Line; time?: string; dateTime?: string }) {
  return (
    <p className="ln-text">
      {line.actor && <strong>{line.actor}</strong>}
      {line.actor && " "}
      {line.verb}
      {line.object && (
        <>
          {" "}
          <strong>{line.object}</strong>
        </>
      )}
      {line.tail && <span className="ln-tail">{line.tail}</span>}
      {time && (
        <time className="ln-time" dateTime={dateTime}>
          {" · "}
          {time}
        </time>
      )}
    </p>
  );
}

/** "Pending", "Blocked", "Failed": a short chip, coloured only by tone. */
export function StatusMark({ status }: { status?: LineStatus }) {
  if (!status) return null;
  return <span className={`ln-chip ln-chip-${status.tone}`}>{status.text}</span>;
}

/**
 * The bank's state when it is the normal one: a small bank icon (posted) or clock (posting), with
 * the detail in a tooltip. Failed entries say so in words instead (`BankProblem`).
 */
export function BankIcon({ marker, note }: { marker: BankMarker | null; note?: { title: string } | null }) {
  if (!marker || (marker.tone !== "posted" && marker.tone !== "queued")) return null;
  // The tooltip says what the icon means: USDC paid, the statement holds a copy (or, for a
  // top-up, the dollars came from checking). Never "the bank paid this".
  const title = note?.title ?? (marker.title ? `${marker.text} · ${marker.title}` : marker.text);
  return (
    <span className={`ln-bank ln-bank-${marker.tone}`} title={title} aria-label={title} role="img">
      {marker.tone === "posted" ? <Bank width={13} height={13} /> : <Clock width={12} height={12} />}
    </span>
  );
}

/** "Not on statement · Retry": the one bank state that needs the owner. */
export function BankProblem({ marker, onRetry, busy = false }: { marker: BankMarker | null; onRetry?(): void; busy?: boolean }) {
  if (!marker || marker.tone !== "failed") return null;
  return (
    <p className="ln-problem" title={marker.title}>
      <Warn width={13} height={13} />
      <span>{marker.text}</span>
      {marker.retry && onRetry && (
        <>
          <span aria-hidden>·</span>
          <button type="button" className="ln-retry" onClick={onRetry} disabled={busy} title="Ask Capital One to post it again">
            {busy ? "Retrying…" : "Retry"}
          </button>
        </>
      )}
    </p>
  );
}

/** The bank's part in words, for detail views: "Paid in USDC · on Capital One statement ••4438". */
export function BankLine({ note }: { note: { line: string; title: string } | null }) {
  if (!note) return null;
  return (
    <p className="ln-sub" title={note.title}>
      {note.line}
    </p>
  );
}

export function AmountText({ amount, title }: { amount: AmountCell | null; title?: string }) {
  if (!amount) return null;
  return (
    <span className={`ln-amt amt-${amount.tone}`} title={title}>
      {amount.text}
    </span>
  );
}

interface RowProps {
  lead: ReactNode;
  line: Line;
  time?: string;
  dateTime?: string;
  amount?: AmountCell | null;
  /** Tooltip on the amount (e.g. "Stopped before it reached your bank"). */
  amountTitle?: string;
  /** Marks between the text and the amount (bank icon). */
  marks?: ReactNode;
  /** Second lines: a bank problem, technical details. */
  children?: ReactNode;
  className?: string;
}

export function LineRow({ lead, line, time, dateTime, amount, amountTitle, marks, children, className = "" }: RowProps) {
  return (
    <li className={`ln-row ${className}`.trim()}>
      <span className="ln-lead">{lead}</span>
      <div className="ln-body">
        <LineText line={line} time={time} dateTime={dateTime} />
        {children}
      </div>
      <span className="ln-end">
        <StatusMark status={line.status} />
        {marks}
        <AmountText amount={amount ?? null} title={amountTitle} />
      </span>
    </li>
  );
}
