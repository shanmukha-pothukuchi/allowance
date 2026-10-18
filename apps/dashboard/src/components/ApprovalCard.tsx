/**
 * One approval, payment or service (docs/ui-rules.md D1). Used by the inbox, the service sheet and
 * the chat embed (§13.5), so the owner sees the same card everywhere. Each fact once: a title with
 * the key fact ("Connect Quantcomm Flood Research?"), one muted meta line with the cap, one muted
 * line of what it may do, the agent's reason clamped to two lines, Approve / Deny. Pricing, the
 * address it pays and ids sit behind "Details".
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { approvalOutcomeLabel, counterpartyName, isCustomGrant, isServiceApproval, shortHex, shortOrigin } from "../format";
import { approvalTitle, capMeta, capUnit, permissionsLine, pricingBeyondCap, shortAgo } from "../lines";
import { shopifyRefOf } from "../shopify";
import type { Approval } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { ArrowOut, Check, Cross, Warn } from "./Icons";
import { StorefrontLink } from "./ShopifyParts";

interface Props {
  approval: Approval;
  now: number;
  busy?: boolean;
  showDetails?: boolean;
  /**
   * "embed" is the chat version: no frame, and no agent name (the chat thread already says who).
   * "service" sits inside that service's sheet, which already shows its provider, permissions and
   * address, so the card keeps only who asks, the cap and the reason.
   */
  variant?: "panel" | "embed" | "service";
  onApprove?(id: string): void;
  onDeny?(id: string): void;
}

/** "a · b · c", skipping empty parts; a line that starts with words starts with a capital. */
function joined(parts: ReactNode[]): ReactNode[] {
  return parts
    .filter((p) => p !== "" && p !== null && p !== undefined && p !== false)
    .map((p, i) => (i === 0 && typeof p === "string" ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .flatMap((p, i) => (i === 0 ? [p] : [" · ", p]));
}

export function ApprovalCard({ approval: a, now, busy = false, showDetails = false, variant = "panel", onApprove, onDeny }: Props) {
  const service = isServiceApproval(a) ? a.service : undefined;
  const custom = isCustomGrant(service);
  const shop = shopifyRefOf(service);
  // An agent asked for a store that is not in the directory yet (§15.3): approving adds it.
  const proposedStore = !!shop && service?.source === "agent";
  const pending = a.status === "pending";
  const embed = variant === "embed";
  const inSheet = variant === "service";
  const [details, setDetails] = useState(showDetails);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const reasonRef = useRef<HTMLQuoteElement>(null);

  // Only offer "show more" when the two-line clamp actually hides something.
  useLayoutEffect(() => {
    const el = reasonRef.current;
    if (!el || reasonOpen) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a.reason, reasonOpen]);

  const to = counterpartyName(a);
  const meta = joined([
    !embed && (
      <span key="who" className="ap-who">
        <AgentAvatar name={a.agentName} size="xs" /> {a.agentName}
      </span>
    ),
    service ? (inSheet ? "" : shop ? <StorefrontLink key="shop" shop={shop} className="shop-link shop-link-quiet" /> : custom ? "" : service.provider) : a.description && a.description !== to ? a.description : "",
    service ? capMeta(service.maxPrice ?? a.amount, capUnit(service.pricing, !!shop)) : "",
  ]);
  const perms = service && !inSheet ? permissionsLine(service.permissions) : "";
  const pricing = service && !inSheet ? pricingBeyondCap(service) : "";
  const detailRows: [string, ReactNode][] = [
    ...(pricing ? ([["Pricing", pricing]] as [string, ReactNode][]) : []),
    ...(service && !custom && !inSheet ? ([["Pays only under", <code key="u">{service.baseUrl}</code>]] as [string, ReactNode][]) : []),
    ...(!service && a.counterparty.origin ? ([["Site", shortOrigin(a.counterparty.origin)]] as [string, ReactNode][]) : []),
    ...(!service && a.counterparty.address ? ([["Address", <code key="a">{shortHex(a.counterparty.address, 8, 6)}</code>]] as [string, ReactNode][]) : []),
    ...(showDetails ? ([["Approval", <code key="i">{a.id}</code>]] as [string, ReactNode][]) : []),
  ];

  const cls = ["ap-card", `ap-${variant}`, custom ? "ap-custom" : "", pending ? "" : `ap-done ap-${a.status}`].filter(Boolean).join(" ");

  return (
    <article className={cls} aria-busy={busy} aria-label={approvalTitle(a)}>
      <header className="ap-head">
        {service ? (
          <ServiceTile name={service.name} color={service.color} size="xs" shopify={!!shop} />
        ) : (
          <span className="ap-pay-ic" aria-hidden>
            <ArrowOut width={13} height={13} />
          </span>
        )}
        <h3 className="ap-title">{approvalTitle(a)}</h3>
        <time className="ap-time" dateTime={a.createdAt}>
          {shortAgo(a.createdAt, now)}
        </time>
      </header>

      {meta.length > 0 && <p className="ap-meta">{meta}</p>}

      {pending && (
        <>
          {perms && <p className="ap-perms">{perms}</p>}
          {custom && service && !inSheet && (
            <p className="ap-warn" role="note">
              <Warn width={14} height={14} />
              <span>
                Not from the directory: {a.agentName} wrote it and chose where it pays, <code>{service.baseUrl}</code>
              </span>
            </p>
          )}
          {proposedStore && <p className="ap-perms">New store: approving adds it to your services.</p>}
          {a.reason && (
            <blockquote
              ref={reasonRef}
              className={`ap-reason${reasonOpen ? " ap-reason-open" : ""}${clamped || reasonOpen ? " ap-reason-more" : ""}`}
              title={`${a.agentName}'s reason, in its own words`}
              onClick={() => (clamped || reasonOpen) && setReasonOpen((o) => !o)}
            >
              {a.reason}
            </blockquote>
          )}
          {details && detailRows.length > 0 && (
            <dl className="ap-details">
              {detailRows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="ap-actions">
            <button className="btn btn-primary" disabled={busy || !onApprove} onClick={() => onApprove?.(a.id)}>
              Approve
            </button>
            <button className="btn" disabled={busy || !onDeny} onClick={() => onDeny?.(a.id)}>
              Deny
            </button>
            {detailRows.length > 0 && (
              <button type="button" className="ap-more" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
                {details ? "Hide details" : "Details"}
              </button>
            )}
          </div>
        </>
      )}

      {!pending && (
        <p className={`ap-outcome outcome-${a.status}`} role="status">
          {a.status === "approved" ? <Check width={14} height={14} /> : <Cross width={14} height={14} />}
          <span>
            {approvalOutcomeLabel(a)}
            {a.decidedAt && <span className="muted"> · {shortAgo(a.decidedAt, now)}</span>}
          </span>
        </p>
      )}
    </article>
  );
}
