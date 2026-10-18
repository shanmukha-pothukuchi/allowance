import { describeEvent, isServiceApproval, isSoftBlock, money, relativeTime, serviceOfEvent, shortHex, signedMoney } from "../format";
import { connectedByLabel } from "../services";
import type { ConnectedService, EventType, WalletEvent } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { ArrowIn, ArrowOut, Check, Clock, Cross, Info, Plug, Plus, Shield, Snowflake, Sun, Unplug } from "./Icons";

interface Props {
  events: WalletEvent[];
  /** Approvals still open: their rows point at the inbox, where they are decided. */
  pendingIds: Set<string>;
  showDetails: boolean;
  now: number;
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

/** The amount column: signed like a statement, struck through when the wallet refused it. */
function amountOf(e: WalletEvent, tone: Tone): { text: string; cls: string } | null {
  const raw = e.receipt?.amount ?? (e.type === "payment.needs_approval" ? e.approval?.amount : undefined);
  if (raw === undefined || e.type === "approval.approved" || e.type === "approval.denied") return null;
  if (tone === "danger" || tone === "soft") return { text: money(raw), cls: "amt-void" };
  if (tone === "in") return { text: signedMoney(raw, "+"), cls: "amt-in" };
  if (tone === "pending") return { text: money(raw), cls: "amt-pending" };
  return { text: signedMoney(raw, "-"), cls: "amt-out" };
}

const isServiceEvent = (e: WalletEvent) => e.type.startsWith("service.") || ((e.type === "approval.approved" || e.type === "approval.denied") && isServiceApproval(e.approval));

export function ActivityFeed({ events, pendingIds, showDetails, now }: Props) {
  return (
    <ol className="feed-list">
        {events.length === 0 && <li className="empty">Waiting for the first payment&hellip;</li>}
        {events.map((e) => {
          const tone = toneFor(e.type, e);
          const approvalId = e.approval?.id;
          const asks = e.type === "payment.needs_approval" || e.type === "service.requested";
          const stillPending = asks && approvalId && pendingIds.has(approvalId);
          const svc = isServiceEvent(e) ? serviceOfEvent(e) : undefined;
          const amt = amountOf(e, tone);
          const by = e.type === "service.connected" ? ((e.data as { connectedBy?: ConnectedService["connectedBy"] } | undefined)?.connectedBy ?? (svc as Partial<ConnectedService> | undefined)?.connectedBy) : undefined;
          // Rows are keyed by event id and mount once, so the CSS entry animation runs exactly once.
          return (
            <li key={e.id} className={`feed-row tone-${tone}${svc ? " feed-service" : ""}`}>
              {e.agentName ? (
                <AgentAvatar name={e.agentName} size="sm" badge={<IconFor type={e.type} />} />
              ) : (
                <span className="feed-icon"><IconFor type={e.type} /></span>
              )}
              <div className="feed-body">
                <p className="feed-text">{describeEvent(e)}</p>
                <span className="feed-meta">
                  {e.agentName && <span className="feed-agent">{e.agentName}</span>}
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
                {stillPending && <span className="feed-waiting">Waiting on you · decide above</span>}
              </div>
              {amt ? <span className={`feed-amt ${amt.cls}`}>{amt.text}</span> : svc ? <ServiceTile name={svc.name} color={svc.color} size="sm" title={svc.name} /> : <span />}
            </li>
          );
        })}
    </ol>
  );
}
