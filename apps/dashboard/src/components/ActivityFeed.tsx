import { describeEvent, isServiceApproval, isSoftBlock, money, relativeTime, serviceOfEvent, shortHex } from "../format";
import { connectedByLabel } from "../services";
import type { ConnectedService, EventType, WalletEvent } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { ArrowIn, ArrowOut, Check, Clock, Cross, Info, Plug, Plus, Shield, Snowflake, Sun, Unplug } from "./Icons";

interface Props {
  events: WalletEvent[];
  pendingIds: Set<string>;
  busyApprovals: string[];
  showDetails: boolean;
  now: number;
  onApprove(id: string): void;
  onDeny(id: string): void;
}

type Tone = "neutral" | "out" | "in" | "danger" | "pending" | "ok" | "soft";

export function toneFor(type: EventType, e?: WalletEvent): Tone {
  if (e && isSoftBlock(e)) return "soft"; // e.g. "not connected": the agent asks, nothing froze
  switch (type) {
    case "earning.received":
    case "topup":
      return "in";
    case "payment.blocked":
    case "agent.frozen":
      return "danger";
    case "payment.needs_approval":
    case "service.requested":
      return "pending";
    case "approval.approved":
    case "agent.unfrozen":
    case "service.connected":
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
  const p = { width: 14, height: 14, strokeWidth: 2.8 };
  switch (type) {
    case "earning.received":
      return <ArrowIn {...p} />;
    case "topup":
      return <Plus {...p} />;
    case "payment.blocked":
      return <Shield {...p} />;
    case "agent.frozen":
      return <Snowflake {...p} />;
    case "agent.unfrozen":
      return <Sun {...p} />;
    case "payment.needs_approval":
      return <Clock {...p} />;
    case "service.requested":
    case "service.connected":
      return <Plug {...p} />;
    case "service.disconnected":
      return <Unplug {...p} />;
    case "approval.approved":
      return <Check {...p} />;
    case "approval.denied":
      return <Cross {...p} />;
    case "payment.signed":
    case "payment.settled":
    case "transfer.sent":
      return <ArrowOut {...p} />;
    default:
      return <Info {...p} />;
  }
}

const isServiceEvent = (e: WalletEvent) => e.type.startsWith("service.") || ((e.type === "approval.approved" || e.type === "approval.denied") && isServiceApproval(e.approval));

export function ActivityFeed({ events, pendingIds, busyApprovals, showDetails, now, onApprove, onDeny }: Props) {
  return (
    <section className="panel feed">
      <h2 className="panel-title">Live activity</h2>
      <ol className="feed-list">
        {events.length === 0 && <li className="empty">Waiting for the first payment&hellip;</li>}
        {events.map((e) => {
          const tone = toneFor(e.type, e);
          const approvalId = e.approval?.id;
          const asks = e.type === "payment.needs_approval" || e.type === "service.requested";
          const stillPending = asks && approvalId && pendingIds.has(approvalId);
          const svc = isServiceEvent(e) ? serviceOfEvent(e) : undefined;
          const by = e.type === "service.connected" ? ((e.data as { connectedBy?: ConnectedService["connectedBy"] } | undefined)?.connectedBy ?? (svc as Partial<ConnectedService> | undefined)?.connectedBy) : undefined;
          // Rows are keyed by event id and mount once, so the CSS entry animation runs exactly once.
          return (
            <li key={e.id} className={`feed-row tone-${tone}${svc ? " feed-service" : ""}`}>
              {e.agentName ? (
                <AgentAvatar name={e.agentName} size="md" badge={<IconFor type={e.type} />} />
              ) : (
                <span className="feed-icon"><IconFor type={e.type} /></span>
              )}
              <div className="feed-body">
                <p className="feed-text">{describeEvent(e)}</p>
                <span className="feed-meta">
                  {e.agentName && <span className="agent-chip">{e.agentName}</span>}
                  <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
                  {by && <span className="by-chip">{connectedByLabel(by)}</span>}
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
                    {e.type === "payment.needs_approval" && <strong>{money(e.approval!.amount)}</strong>}
                    <button className="btn btn-primary" disabled={busyApprovals.includes(approvalId!)} onClick={() => onApprove(approvalId!)}>
                      <Check width={18} height={18} /> Approve
                    </button>
                    <button className="btn btn-danger" disabled={busyApprovals.includes(approvalId!)} onClick={() => onDeny(approvalId!)}>
                      <Cross width={18} height={18} /> Deny
                    </button>
                  </div>
                )}
              </div>
              {svc && <ServiceTile icon={svc.icon} color={svc.color} size="md" title={svc.name} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
