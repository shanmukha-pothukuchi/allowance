/**
 * One approval, payment or service. Used by the approvals panel, the service sheet and the
 * chat embed (§13.5), so the owner sees the same card everywhere.
 */
import { approvalOutcomeLabel, counterpartyName, isCustomGrant, isServiceApproval, money, relativeTime, shortHex, shortOrigin } from "../format";
import { priceCapLabel } from "../services";
import { capLabel, shopifyRefOf, storefrontHost } from "../shopify";
import type { Approval } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { Check, Cross, Info, ShoppingBag, Warn } from "./Icons";

interface Props {
  approval: Approval;
  now: number;
  busy?: boolean;
  showDetails?: boolean;
  /** "embed" is the compact chat version. */
  variant?: "panel" | "embed";
  onApprove?(id: string): void;
  onDeny?(id: string): void;
}

export function ApprovalCard({ approval: a, now, busy = false, showDetails = false, variant = "panel", onApprove, onDeny }: Props) {
  const service = isServiceApproval(a) ? a.service : undefined;
  const custom = isCustomGrant(service);
  const shop = shopifyRefOf(service);
  // An agent asked for a store that is not in the directory yet (§15.3): approving adds it.
  const proposedStore = !!shop && service?.source === "agent";
  const pending = a.status === "pending";
  const cls = [
    "approval-card",
    `approval-${variant}`,
    service ? "approval-service" : "approval-payment",
    custom ? "approval-custom" : "",
    shop ? "approval-shopify" : "",
    pending ? "" : `approval-done approval-${a.status}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cls} aria-busy={busy}>
      <header className="approval-head">
        <AgentAvatar name={a.agentName} size={variant === "embed" ? "sm" : "md"} />
        <p className="approval-who">
          <strong>{a.agentName}</strong> {proposedStore ? "wants to add a Shopify store" : service ? "wants to connect" : "wants to pay"}
        </p>
        <time className="approval-time" dateTime={a.createdAt}>
          {relativeTime(a.createdAt, now)}
        </time>
      </header>

      {service && shop ? (
        <>
          <div className="approval-service-row">
            <ServiceTile name={service.name} shopify size={variant === "embed" ? "md" : "lg"} />
            <div className="approval-service-name">
              <span className="svc-name">{service.name}</span>
              <span className="svc-provider shop-domain">
                <ShoppingBag width={13} height={13} /> Shopify store · {storefrontHost(shop)}
              </span>
            </div>
          </div>
          {service.permissions.length > 0 && (
            <ul className="perm-list" aria-label="What it can do">
              {service.permissions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <p className="price-cap">
            <span className="stat-label">Per-order cap</span> {capLabel(service.maxPrice ?? a.amount)}
          </p>
          {proposedStore && pending && (
            <p className="shop-note" role="note">
              <Info width={16} height={16} /> <span>Not in your services yet. Approving adds it and connects it to {a.agentName}.</span>
            </p>
          )}
          {a.reason && (
            <figure className="agent-quote">
              <figcaption>{a.agentName}'s reason, in its own words</figcaption>
              <blockquote>{a.reason}</blockquote>
            </figure>
          )}
          {showDetails && <code className="hash">{service.baseUrl}</code>}
        </>
      ) : service ? (
        <>
          <div className="approval-service-row">
            <ServiceTile name={service.name} color={service.color} size={variant === "embed" ? "md" : "lg"} />
            <div className="approval-service-name">
              <span className="svc-name">{service.name}</span>
              <span className="svc-provider">
                {custom ? "Proposed by the agent" : `by ${service.provider}`} · {service.pricing}
              </span>
            </div>
          </div>
          {custom && (
            <div className="custom-warning" role="note">
              <Warn width={20} height={20} />
              <div>
                <strong>Not from the directory.</strong> {a.agentName} wrote this service itself. Check where it pays:
                <code className="custom-url">{service.baseUrl}</code>
              </div>
            </div>
          )}
          {service.permissions.length > 0 && (
            <ul className="perm-list" aria-label="What it can do">
              {service.permissions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <p className="price-cap">
            <span className="stat-label">Price cap</span> {priceCapLabel(service.maxPrice ?? a.amount)}
          </p>
          {a.reason && (
            <figure className="agent-quote">
              <figcaption>{a.agentName}'s reason, in its own words</figcaption>
              <blockquote>{a.reason}</blockquote>
            </figure>
          )}
          {showDetails && !custom && <code className="hash">{service.baseUrl}</code>}
        </>
      ) : (
        <div className="approval-pay-row">
          <div className="approval-amount">{money(a.amount)}</div>
          <p className="approval-to">
            to <strong>{counterpartyName(a)}</strong>
            {a.counterparty.origin && <span className="muted"> · {shortOrigin(a.counterparty.origin)}</span>}
          </p>
          {a.description && a.description !== counterpartyName(a) && <p className="approval-desc">{a.description}</p>}
          {showDetails && <code className="hash">to {shortHex(a.counterparty.address, 8, 6)}</code>}
        </div>
      )}

      {pending ? (
        <div className="approval-actions">
          <button className="btn btn-primary btn-big" disabled={busy || !onApprove} onClick={() => onApprove?.(a.id)}>
            <Check /> Approve
          </button>
          <button className="btn btn-danger btn-big" disabled={busy || !onDeny} onClick={() => onDeny?.(a.id)}>
            <Cross /> Deny
          </button>
        </div>
      ) : (
        <p className={`approval-outcome outcome-${a.status}`} role="status">
          {a.status === "approved" ? <Check /> : <Cross />}
          <span>
            {approvalOutcomeLabel(a)}
            {a.decidedAt && <span className="muted"> · {relativeTime(a.decidedAt, now)}</span>}
          </span>
        </p>
      )}
      {showDetails && <code className="hash approval-id">{a.id}</code>}
    </article>
  );
}
