/** Capital One (§16, Nessie sandbox) building blocks: the receipt marker, a statement, the bank tile. */
import { entryAmount, entryIn, entryTitle, KIND_LABEL, nessieStatus, statementDate, statusTone, type BankMarker } from "../bank";
import type { BankStatementEntry } from "../types";
import { Bank, Check, Clock, Shield, Warn } from "./Icons";

/** A soft tile with a bank building: Capital One, without borrowing its logo. */
export function BankTile({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`bank-tile bank-tile-${size}`} aria-hidden>
      <Bank />
    </span>
  );
}

/**
 * "On Capital One statement" / "Posting to Capital One…" / "Not on statement · Retry" / "Stopped
 * before it reached your bank". Retry re-queues every failed entry (`POST /v1/bank/retry`).
 */
export function BankMarkerView({ marker, onRetry, busy = false }: { marker: BankMarker | null; onRetry?(): void; busy?: boolean }) {
  if (!marker) return null;
  const icon =
    marker.tone === "posted" ? <Check width={13} height={13} /> : marker.tone === "queued" ? <Clock width={13} height={13} /> : marker.tone === "failed" ? <Warn width={13} height={13} /> : <Shield width={13} height={13} />;
  return (
    <span className={`bank-mark bank-mark-${marker.tone}`} title={marker.title}>
      {icon}
      <span>{marker.text}</span>
      {marker.retry && onRetry && (
        <>
          <span aria-hidden>·</span>
          <button type="button" className="bank-retry" onClick={onRetry} disabled={busy} title="Ask Capital One to post it again">
            {busy ? "Retrying…" : "Retry"}
          </button>
        </>
      )}
    </span>
  );
}

/** Statement rows: merchant, kind and date, signed amount, and Nessie's own status. */
export function StatementList({ entries, now, max = 8 }: { entries: BankStatementEntry[]; now: number; max?: number }) {
  const shown = entries.slice(0, max);
  return (
    <ul className="stmt-list">
      {shown.map((e) => {
        const tone = statusTone(e.status);
        return (
          <li key={e.id} className="stmt-row">
            <span className={`stmt-ic ${entryIn(e) ? "stmt-in" : "stmt-out"}`} aria-hidden>
              {entryIn(e) ? "+" : "−"}
            </span>
            <span className="stmt-main">
              <span className="stmt-what">{entryTitle(e)}</span>
              <span className="stmt-sub">
                {KIND_LABEL[e.kind] ?? e.kind} · {statementDate(e.date, now)}
              </span>
            </span>
            <span className="stmt-right">
              <span className={`stmt-amt${entryIn(e) ? " amt-in" : ""}`}>{entryAmount(e)}</span>
              {nessieStatus(e.status) && (
                <span className={`stmt-status stmt-${tone}`} title="Nessie's status for this entry">
                  {nessieStatus(e.status)}
                </span>
              )}
            </span>
          </li>
        );
      })}
      {entries.length > shown.length && <li className="stmt-more muted">+{entries.length - shown.length} older</li>}
    </ul>
  );
}
