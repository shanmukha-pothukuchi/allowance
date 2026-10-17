import type { Approval } from "../types";
import { ApprovalCard } from "./ApprovalCard";

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
            <li key={a.id}>
              <ApprovalCard approval={a} now={now} busy={busy.includes(a.id)} showDetails={showDetails} onApprove={onApprove} onDeny={onDeny} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
