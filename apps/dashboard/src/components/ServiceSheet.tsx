/** Detail sheet for one service: what it is, what it can do, and a switch per agent. */
import { useEffect, useRef } from "react";
import { relativeTime } from "../format";
import { CATEGORIES, connectedByLabel, priceCapLabel, requestsFor, type CatalogEntry } from "../services";
import { capLabel, HOW_IT_PAYS, pricingWithoutCap, shopifyRefOf } from "../shopify";
import { serviceKey, type DashboardState } from "../state";
import type { WalletActions } from "../useWallet";
import { ApprovalCard } from "./ApprovalCard";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { Close, CreditCard, ShoppingBag, Warn } from "./Icons";
import { StorefrontLink } from "./ShopifyParts";
import { Switch } from "./Switch";

interface Props {
  entry: CatalogEntry;
  state: DashboardState;
  actions: WalletActions;
  now: number;
  onClose(): void;
}

const KIND_LABEL: Record<string, string> = { x402: "Pay per request (x402)", "agent-work": "Paid tasks (agent-work)", directory: "Directory" };

export function ServiceSheet({ entry, state, actions, now, onClose }: Props) {
  const s = entry.service;
  const closeRef = useRef<HTMLButtonElement>(null);
  const requests = requestsFor(state.approvals, s.id);
  const docs = s.docs || state.serviceDocs[s.id];
  const category = CATEGORIES.find((c) => c.id === s.category)?.label ?? s.category;
  const shop = shopifyRefOf(s);
  // A store an agent asked for that is not in the directory yet: nothing to switch on until approved.
  const notListed = !!entry.proposal && !entry.custom;

  useEffect(() => {
    if (!s.docs && state.serviceDocs[s.id] === undefined && !entry.custom && !entry.proposal) void actions.loadServiceDocs(s.id);
  }, [s.id]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden />
      <aside className={`sheet${entry.custom ? " sheet-custom" : ""}`} role="dialog" aria-modal="true" aria-label={s.name}>
        <header className="sheet-head">
          <ServiceTile name={s.name} color={s.color} size="xl" shopify={!!shop} />
          <div className="sheet-title">
            <h2>{s.name}</h2>
            {shop ? (
              <>
                <p className="muted sheet-shop-sub">
                  <span>
                    <ShoppingBag width={15} height={15} /> Shopify store
                  </span>
                  <span>
                    · <StorefrontLink shop={shop} className="shop-link shop-link-quiet" />
                  </span>
                </p>
              </>
            ) : (
              <p className="muted">
                {entry.custom ? s.provider : `by ${s.provider}`} · {category} · {KIND_LABEL[s.kind] ?? s.kind}
              </p>
            )}
          </div>
          <button ref={closeRef} className="icon-btn sheet-close" onClick={onClose} aria-label="Close">
            <Close width={22} height={22} />
          </button>
        </header>

        <div className="sheet-body">
          {entry.custom && (
            <div className="custom-warning" role="note">
              <Warn width={22} height={22} />
              <div>
                <strong>Proposed by {entry.proposedBy.map((a) => a.name).join(", ") || "an agent"}.</strong> Not from the directory: the agent wrote this description
                and chose where it pays.
                <code className="custom-url">{s.baseUrl}</code>
              </div>
            </div>
          )}

          {requests.map((a) => (
            <ApprovalCard key={a.id} approval={a} now={now} busy={state.busyApprovals.includes(a.id)} showDetails={state.showDetails} onApprove={(id) => void actions.approve(id)} onDeny={(id) => void actions.deny(id)} />
          ))}

          <p className="sheet-desc">{s.description || s.summary}</p>

          {shop && (
            <p className="shop-note shop-how-block">
              <CreditCard width={18} height={18} />
              <span>{HOW_IT_PAYS}</span>
            </p>
          )}

          {shop ? (
            <dl className="sheet-facts">
              <div>
                <dt>Pricing</dt>
                <dd>{pricingWithoutCap(s.pricing) || s.pricing}</dd>
              </div>
              <div>
                <dt>Per-order cap</dt>
                <dd>{capLabel(s.maxPrice)}</dd>
              </div>
              <div className="fact-wide">
                <dt>Store</dt>
                <dd>
                  <StorefrontLink shop={shop} />
                  {shop.cardCheckout && <span className="muted shop-card-fact"> · accepts card checkout for agents</span>}
                </dd>
              </div>
              <div className="fact-wide">
                <dt>Pays only under</dt>
                <dd><code>{s.baseUrl}</code></dd>
              </div>
            </dl>
          ) : (
            <dl className="sheet-facts">
              <div>
                <dt>Pricing</dt>
                <dd>{s.pricing}</dd>
              </div>
              <div>
                <dt>Price cap</dt>
                <dd>{priceCapLabel(s.maxPrice)}</dd>
              </div>
              <div className="fact-wide">
                <dt>Pays only under</dt>
                <dd><code>{s.baseUrl}</code></dd>
              </div>
            </dl>
          )}

          {s.permissions.length > 0 && (
            <section className="sheet-section">
              <h3>What a connected agent can do</h3>
              <ul className="perm-list">
                {s.permissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="sheet-section">
            <h3>Agents</h3>
            {entry.builtIn ? (
              <p className="muted">Every agent always has the directory. It cannot spend money.</p>
            ) : notListed ? (
              <p className="muted">Not in your services yet. Approve {entry.proposedBy.map((a) => a.name).join(", ") || "the agent"}'s request above to add it and connect it.</p>
            ) : (
              <ul className="switch-list">
                {(entry.custom ? entry.connections.map((c) => c.agent) : state.agents).map((agent) => {
                  const conn = entry.connections.find((c) => c.agent.id === agent.id);
                  const key = serviceKey(agent.id, s.id);
                  return (
                    <li key={agent.id} className={`switch-row${conn ? " switch-row-on" : ""}`}>
                      <AgentAvatar name={agent.name} size="sm" />
                      <span className="switch-name">{agent.name}</span>
                      <span className="switch-meta">
                        {conn ? (
                          <>
                            <span className={`by-chip by-${conn.service.connectedBy}`}>{connectedByLabel(conn.service.connectedBy)}</span>
                            {conn.service.connectedAt && <span className="muted"> {relativeTime(conn.service.connectedAt, now)}</span>}
                          </>
                        ) : (
                          <span className="muted">off</span>
                        )}
                      </span>
                      <Switch
                        on={!!conn}
                        busy={state.busyServices.includes(key)}
                        label={`${s.name} for ${agent.name}`}
                        onChange={(next) => void (next ? actions.connectService(agent.id, s.id) : actions.disconnectService(agent.id, s.id))}
                      />
                    </li>
                  );
                })}
                {entry.custom && entry.connections.length === 0 && <li className="muted">Not connected to any agent yet.</li>}
              </ul>
            )}
            {entry.custom && <p className="muted sheet-note">Custom services are connected only when you approve the agent's request. You can disconnect them here.</p>}
          </section>

          <details className="docs">
            <summary>Usage docs <span className="muted">(what the agent reads before calling it)</span></summary>
            {docs ? <pre>{docs}</pre> : <p className="muted">{state.serviceDocs[s.id] === undefined && !entry.custom && !entry.proposal ? "Loading…" : notListed ? "Written when the store is added." : "No docs."}</p>}
          </details>
        </div>
      </aside>
    </>
  );
}
