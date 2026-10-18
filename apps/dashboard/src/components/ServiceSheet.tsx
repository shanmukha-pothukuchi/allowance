/** Detail sheet for one service (D5): one header, its facts as grouped rows, a switch per agent. */
import { useEffect, type ReactNode } from "react";
import { pricingBeyondCap, permissionsLine, shortAgo } from "../lines";
import { CATEGORIES, connectedByLabel, priceCapLabel, requestsFor, type CatalogEntry } from "../services";
import { capLabel, HOW_IT_PAYS, pricingWithoutCap, shopifyRefOf } from "../shopify";
import { serviceKey, type DashboardState } from "../state";
import type { WalletActions } from "../useWallet";
import { ApprovalCard } from "./ApprovalCard";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { Warn } from "./Icons";
import { Facts, Field, SheetShell } from "./SheetParts";
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
  const requests = requestsFor(state.approvals, s.id);
  const docs = s.docs || state.serviceDocs[s.id];
  const category = CATEGORIES.find((c) => c.id === s.category)?.label ?? s.category;
  const shop = shopifyRefOf(s);
  // A store an agent asked for that is not in the directory yet: nothing to switch on until approved.
  const notListed = !!entry.proposal && !entry.custom;
  const proposers = entry.proposedBy.map((a) => a.name).join(", ") || "an agent";
  const can = permissionsLine(s.permissions);
  // Not in the directory (an agent's proposal, or an API added by its link, §18): only the agents
  // that have it can be switched, off.
  const offList = entry.custom || (!entry.builtIn && !entry.proposal && state.directoryStatus === "ready" && !state.directory.some((d) => d.id === s.id));

  useEffect(() => {
    if (!s.docs && state.serviceDocs[s.id] === undefined && !entry.custom && !entry.proposal) void actions.loadServiceDocs(s.id);
  }, [s.id]);

  const head = (
    <div className="osheet-title">
      <ServiceTile name={s.name} color={s.color} size="sm" shopify={!!shop} />
      <div className="osheet-titles">
        <h2 className="osheet-name">{s.name}</h2>
        <p className="osheet-sub">
          {shop ? (
            <>
              Shopify store · <StorefrontLink shop={shop} className="shop-link shop-link-quiet" />
            </>
          ) : entry.custom ? (
            `Proposed by ${proposers}`
          ) : (
            [s.provider !== s.name ? s.provider : "", category, KIND_LABEL[s.kind] ?? s.kind].filter(Boolean).join(" · ")
          )}
        </p>
      </div>
    </div>
  );

  const facts: [string, ReactNode][] = shop
    ? [
        ["Price", pricingWithoutCap(s.pricing) || s.pricing],
        ["Per-order cap", capLabel(s.maxPrice)],
        ...(shop.cardCheckout ? ([["Checkout", "Accepts card checkout for agents"]] as [string, ReactNode][]) : []),
      ]
    : [["Price", s.pricing], ...(pricingBeyondCap(s) ? ([["Cap", priceCapLabel(s.maxPrice)]] as [string, ReactNode][]) : [])];
  if (can) facts.push(["Can", can]);
  facts.push(["Pays only under", <code key="u">{s.baseUrl}</code>]);

  return (
    <SheetShell embed={false} label={s.name} head={head} onClose={onClose}>
      {entry.custom && (
        <p className="osheet-warn-line" role="note">
          <Warn width={14} height={14} />
          <span>Not from the directory: the agent wrote this description and chose where it pays.</span>
        </p>
      )}

      {requests.map((a) => (
        <ApprovalCard key={a.id} approval={a} now={now} variant="service" busy={state.busyApprovals.includes(a.id)} showDetails={state.showDetails} onApprove={(id) => void actions.approve(id)} onDeny={(id) => void actions.deny(id)} />
      ))}

      {(s.description || s.summary) && <p className="osheet-desc">{s.description || s.summary}</p>}

      <Facts rows={facts} />
      {shop && <p className="osheet-note">{HOW_IT_PAYS}</p>}

      <Field label="Agents">
        {entry.builtIn ? (
          <p className="muted">Every agent always has the directory. It can't spend money.</p>
        ) : notListed ? (
          <p className="muted">Not in your services yet. Approving {proposers}'s request adds and connects it.</p>
        ) : (
          <ul className="ln-group switch-list">
            {(offList ? entry.connections.map((c) => c.agent) : state.agents).map((agent) => {
              const conn = entry.connections.find((c) => c.agent.id === agent.id);
              const key = serviceKey(agent.id, s.id);
              return (
                <li key={agent.id} className="grow">
                  <AgentAvatar name={agent.name} size="xs" />
                  <span className="grow-main">
                    <span className="grow-title">{agent.name}</span>
                  </span>
                  {conn && (
                    <span className="grow-meta">
                      {connectedByLabel(conn.service.connectedBy)}
                      {conn.service.connectedAt && ` · ${shortAgo(conn.service.connectedAt, now)}`}
                    </span>
                  )}
                  <Switch
                    on={!!conn}
                    busy={state.busyServices.includes(key)}
                    label={`${s.name} for ${agent.name}`}
                    onChange={(next) => void (next ? actions.connectService(agent.id, s.id) : actions.disconnectService(agent.id, s.id))}
                  />
                </li>
              );
            })}
            {offList && entry.connections.length === 0 && <li className="grow muted">Not connected to any agent yet.</li>}
          </ul>
        )}
        {entry.custom && <p className="ofield-hint">Connected only when you approve the agent's request. You can disconnect it here.</p>}
        {offList && !entry.custom && <p className="ofield-hint">Added by its link. Connect more agents with Add service.</p>}
      </Field>

      <details className="osheet-details">
        <summary>Usage docs</summary>
        {docs ? <pre className="docs-pre">{docs}</pre> : <p className="muted">{state.serviceDocs[s.id] === undefined && !entry.custom && !entry.proposal ? "Loading…" : notListed ? "Written when the store is added." : "No docs."}</p>}
      </details>
    </SheetShell>
  );
}
