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

/** The inbox: what is waiting on the owner, at the top of the page. It says "Waiting on you" here and in the rail badge only. */
export function ApprovalsPanel({ approvals, busy, showDetails, now, onApprove, onDeny }: Props) {
  return (
    <section className="inbox" aria-label="Waiting on you">
      <div className="section-head">
        <h2 className="section-title">
          Waiting on you <span className="muted">{approvals.length}</span>
        </h2>
      </div>
      <ul className="approval-list">
        {approvals.map((a) => (
          <li key={a.id}>
            <ApprovalCard approval={a} now={now} busy={busy.includes(a.id)} showDetails={showDetails} onApprove={onApprove} onDeny={onDeny} />
          </li>
        ))}
      </ul>
    </section>
  );
}
