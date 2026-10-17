import { counterpartyName, money, receiptStatusLabel, relativeTime, shortHex, signedMoney } from "../format";
import type { Receipt } from "../types";

interface Props {
  receipts: Receipt[];
  showDetails: boolean;
  now: number;
}

function amountFor(r: Receipt): { text: string; cls: string } {
  if (r.status === "blocked" || r.status === "denied" || r.status === "failed") return { text: money(r.amount), cls: "amt-void" };
  if (r.kind === "earn" || r.kind === "topup") return { text: signedMoney(r.amount, "+"), cls: "amt-in" };
  if (r.status === "pending_approval") return { text: money(r.amount), cls: "amt-pending" };
  return { text: signedMoney(r.amount, "-"), cls: "amt-out" };
}

export function ReceiptsList({ receipts, showDetails, now }: Props) {
  return (
    <section className="panel receipts">
      <h2 className="panel-title">Receipts</h2>
      {receipts.length === 0 ? (
        <p className="empty">No receipts yet.</p>
      ) : (
        <ul className="receipt-list">
          {receipts.map((r) => {
            const amt = amountFor(r);
            return (
              <li key={r.id} className={`receipt-row status-${r.status}`}>
                <div className="receipt-main">
                  <span className="receipt-what">{r.description || counterpartyName(r)}</span>
                  <span className={`receipt-amt ${amt.cls}`}>{amt.text}</span>
                </div>
                <div className="receipt-sub">
                  <span className="agent-chip">{r.agentName}</span>
                  <span>{r.kind === "earn" ? "from" : "to"} {counterpartyName(r)}</span>
                  <span className={`status-chip status-${r.status}`}>{receiptStatusLabel(r.status)}</span>
                  <time dateTime={r.createdAt}>{relativeTime(r.createdAt, now)}</time>
                </div>
                {showDetails && (
                  <div className="receipt-details">
                    <code title={r.counterparty.address}>{shortHex(r.counterparty.address, 8, 6)}</code>
                    {r.txHash &&
                      (r.explorerUrl ? (
                        <a href={r.explorerUrl} target="_blank" rel="noreferrer">tx {shortHex(r.txHash, 8, 6)}</a>
                      ) : (
                        <code>tx {shortHex(r.txHash, 8, 6)}</code>
                      ))}
                    <code>{r.id}</code>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
