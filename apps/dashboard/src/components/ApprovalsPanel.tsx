import { counterpartyName, money, relativeTime, shortHex } from "../format";
import type { Approval } from "../types";
import { Check, Cross } from "./Icons";

interface Props {
  approvals: Approval[];
  busy: string[];
  showDetails: boolean;
  now: number;
  onApprove(id: string): void;
  onDeny(id: string): void;
}

export function ApprovalsPanel({ approvals, busy, showDetails, now, onApprove, onDeny }: Props) {
  return (
    <section className={`panel approvals${approvals.length ? " has-pending" : ""}`}>
      <h2 className="panel-title">
        Needs your approval
        {approvals.length > 0 && <span className="count-badge">{approvals.length}</span>}
      </h2>
      {approvals.length === 0 ? (
        <p className="empty">Nothing waiting on you.</p>
      ) : (
        <ul className="approval-list">
          {approvals.map((a) => (
            <li key={a.id} className="approval-card">
              <div className="approval-amount">{money(a.amount)}</div>
              <p className="approval-text">
                <strong>{a.agentName}</strong> wants to pay <strong>{counterpartyName(a)}</strong>
              </p>
              <span className="feed-meta">
                <time dateTime={a.createdAt}>{relativeTime(a.createdAt, now)}</time>
                {showDetails && <code className="hash">to {shortHex(a.counterparty.address, 8, 6)}</code>}
              </span>
              <div className="approval-actions">
                <button className="btn btn-primary btn-big" disabled={busy.includes(a.id)} onClick={() => onApprove(a.id)}>
                  <Check /> Approve
                </button>
                <button className="btn btn-danger btn-big" disabled={busy.includes(a.id)} onClick={() => onDeny(a.id)}>
                  <Cross /> Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
