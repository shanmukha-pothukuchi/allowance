import { describeEvent, money, relativeTime, shortHex } from "../format";
import type { EventType, WalletEvent } from "../types";
import { ArrowIn, ArrowOut, Check, Clock, Cross, Info, Plus, Shield, Snowflake, Sun } from "./Icons";

interface Props {
  events: WalletEvent[];
  pendingIds: Set<string>;
  busyApprovals: string[];
  showDetails: boolean;
  now: number;
  onApprove(id: string): void;
  onDeny(id: string): void;
}

type Tone = "neutral" | "out" | "in" | "danger" | "pending" | "ok";

function toneFor(type: EventType): Tone {
  switch (type) {
    case "earning.received":
    case "topup":
      return "in";
    case "payment.blocked":
    case "agent.frozen":
      return "danger";
    case "payment.needs_approval":
      return "pending";
    case "approval.approved":
    case "agent.unfrozen":
      return "ok";
    case "payment.signed":
    case "payment.settled":
    case "transfer.sent":
      return "out";
    default:
      return "neutral";
  }
}

function IconFor({ type }: { type: EventType }) {
  switch (type) {
    case "earning.received":
      return <ArrowIn />;
    case "topup":
      return <Plus />;
    case "payment.blocked":
      return <Shield />;
    case "agent.frozen":
      return <Snowflake />;
    case "agent.unfrozen":
      return <Sun />;
    case "payment.needs_approval":
      return <Clock />;
    case "approval.approved":
      return <Check />;
    case "approval.denied":
      return <Cross />;
    case "payment.signed":
    case "payment.settled":
    case "transfer.sent":
      return <ArrowOut />;
    default:
      return <Info />;
  }
}

export function ActivityFeed({ events, pendingIds, busyApprovals, showDetails, now, onApprove, onDeny }: Props) {
  return (
    <section className="panel feed">
      <h2 className="panel-title">Live activity</h2>
      <ol className="feed-list">
        {events.length === 0 && <li className="empty">Waiting for the first payment&hellip;</li>}
        {events.map((e) => {
          const tone = toneFor(e.type);
          const approvalId = e.approval?.id;
          const stillPending = e.type === "payment.needs_approval" && approvalId && pendingIds.has(approvalId);
          // Rows are keyed by event id and mount once, so the CSS entry animation runs exactly once.
          return (
            <li key={e.id} className={`feed-row tone-${tone}`}>
              <span className="feed-icon"><IconFor type={e.type} /></span>
              <div className="feed-body">
                <p className="feed-text">{describeEvent(e)}</p>
                <span className="feed-meta">
                  {e.agentName && <span className="agent-chip">{e.agentName}</span>}
                  <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
                  {showDetails && e.receipt?.txHash && (
                    e.receipt.explorerUrl ? (
                      <a className="hash" href={e.receipt.explorerUrl} target="_blank" rel="noreferrer">{shortHex(e.receipt.txHash, 8, 6)}</a>
                    ) : (
                      <code className="hash">{shortHex(e.receipt.txHash, 8, 6)}</code>
                    )
                  )}
                  {showDetails && e.receipt?.counterparty.address && (
                    <code className="hash">to {shortHex(e.receipt.counterparty.address, 8, 6)}</code>
                  )}
                </span>
                {stillPending && (
                  <div className="inline-approve">
                    <strong>{money(e.approval!.amount)}</strong>
                    <button className="btn btn-primary" disabled={busyApprovals.includes(approvalId!)} onClick={() => onApprove(approvalId!)}>
                      <Check width={18} height={18} /> Approve
                    </button>
                    <button className="btn btn-danger" disabled={busyApprovals.includes(approvalId!)} onClick={() => onDeny(approvalId!)}>
                      <Cross width={18} height={18} /> Deny
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
