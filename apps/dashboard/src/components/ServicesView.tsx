/** The Services tab: a Muse-style connectors gallery over the directory plus agent-proposed services. */
import { useMemo, useState } from "react";
import { navigate } from "../route";
import { buildCatalog, CATEGORIES, filterCatalog, requestsFor, withProposals, type CatalogEntry, type CategoryFilter } from "../services";
import { toCents } from "../format";
import { shortMoney } from "../sheets";
import { capLabel, shopifyRefOf, storefrontHost } from "../shopify";
import type { DashboardState } from "../state";
import type { WalletActions } from "../useWallet";
import { AvatarStack, ServiceTile } from "./Avatar";
import { Plus, Search, ShoppingBag, Warn } from "./Icons";
import { ServiceSheet } from "./ServiceSheet";

interface Props {
  state: DashboardState;
  actions: WalletActions;
  selectedId?: string;
  now: number;
  /** Open "Add a Shopify store" (§15.5). */
  onAddShopify(): void;
}

export function ServicesView({ state, actions, selectedId, now, onAddShopify }: Props) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryFilter>("all");
  const catalog = useMemo(() => withProposals(buildCatalog(state.directory, state.agents), state.approvals, state.agents), [state.directory, state.agents, state.approvals]);
  const shown = useMemo(() => filterCatalog(catalog, q, cat), [catalog, q, cat]);
  const selected = selectedId ? catalog.find((e) => e.service.id === selectedId) : undefined;
  const connectedTotal = catalog.reduce((n, e) => n + e.connections.length, 0);
  const showAddCard = !q.trim() && (cat === "all" || cat === "shopping") && state.directoryStatus !== "error";

  return (
    <main className="services-view">
      <div className="services-head">
        <div className="services-title">
          <h1>Services</h1>
          <p className="muted">
            Agents can only pay services they are connected to. {connectedTotal} connection{connectedTotal === 1 ? "" : "s"} across {state.agents.length} agents.
          </p>
        </div>
        <div className="services-actions">
          <button type="button" className="btn btn-shopify" onClick={onAddShopify} title="Let your agents shop at a Shopify store">
            <ShoppingBag width={18} height={18} /> Add a Shopify store
          </button>
          <label className="search">
            <Search width={20} height={20} />
            <input type="search" placeholder="Search services" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" />
          </label>
        </div>
      </div>

      <div className="chips" role="tablist" aria-label="Category">
        {CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} className={`chip${cat === c.id ? " chip-on" : ""}`} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="services-scroll">
        {state.directoryStatus === "error" && (
          <div className="directory-error">
            <Warn width={22} height={22} />
            <span>{state.directoryError ?? "The service directory is not reachable."} Services your agents already have still show below.</span>
            <button className="btn" onClick={() => void actions.reloadDirectory()}>Retry</button>
          </div>
        )}
        {state.directoryStatus === "idle" && catalog.length === 0 && <p className="empty">Waiting for the wallet service…</p>}
        {state.directoryStatus === "loading" && catalog.length === 0 && <p className="empty">Loading the directory…</p>}
        {state.directoryStatus === "ready" && shown.length === 0 && <p className="empty">No services match{q ? ` “${q}”` : ""}.</p>}
        <ul className="svc-grid">
          {showAddCard && (state.directoryStatus === "ready" || catalog.length > 0) && (
            <li>
              <button type="button" className="svc-card svc-card-add" onClick={onAddShopify}>
                <div className="svc-card-top">
                  <ServiceTile name="Shopify" shopify size="xl" />
                  <span className="svc-add-plus" aria-hidden>
                    <Plus width={20} height={20} />
                  </span>
                </div>
                <h3 className="svc-name">Add a Shopify store</h3>
                <p className="svc-provider">Any public Shopify store</p>
                <p className="svc-summary">Paste a shop's link. Your agents search it, build carts and pay for orders within your limits.</p>
                <div className="svc-card-foot">
                  <span className="svc-price">Paste a link</span>
                  <span className="muted svc-conn">takes a few seconds</span>
                </div>
              </button>
            </li>
          )}
          {shown.map((e) => (
            <li key={e.service.id}>
              <ServiceCardView entry={e} waiting={requestsFor(state.approvals, e.service.id).length} onOpen={() => navigate({ view: "services", serviceId: e.service.id })} />
            </li>
          ))}
        </ul>
      </div>

      {selected && <ServiceSheet entry={selected} state={state} actions={actions} now={now} onClose={() => navigate({ view: "services" })} />}
    </main>
  );
}

function ServiceCardView({ entry, waiting, onOpen }: { entry: CatalogEntry; waiting: number; onOpen(): void }) {
  const s = entry.service;
  const names = entry.connections.map((c) => c.agent.name);
  const shop = shopifyRefOf(s);
  return (
    <button className={`svc-card${entry.custom ? " svc-card-custom" : ""}${shop ? " svc-card-shopify" : ""}${waiting ? " svc-card-waiting" : ""}`} onClick={onOpen}>
      <div className="svc-card-top">
        <ServiceTile name={s.name} color={s.color} size="xl" shopify={!!shop} />
        <div className="svc-badges">
          {waiting > 0 && <span className="badge badge-warn">{waiting} waiting for you</span>}
          {entry.custom && <span className="badge badge-custom">Proposed by {entry.proposedBy.map((a) => a.name).join(", ") || "an agent"}</span>}
          {shop && (
            <span className="badge badge-shopify">
              <ShoppingBag width={12} height={12} /> Shopify
            </span>
          )}
          {entry.builtIn && <span className="badge">Built in</span>}
        </div>
      </div>
      <h3 className="svc-name">{s.name}</h3>
      <p className="svc-provider">{shop ? storefrontHost(shop) : entry.custom ? s.provider : `by ${s.provider}`}</p>
      <p className="svc-summary">{s.summary}</p>
      <div className="svc-card-foot">
        <span className="svc-price">{shop ? (toCents(s.maxPrice) > 0 ? `Up to ${shortMoney(s.maxPrice)} per order` : capLabel(s.maxPrice)) : s.pricing}</span>
        {entry.builtIn ? (
          <span className="muted svc-conn">every agent</span>
        ) : entry.proposal && shop ? (
          <span className="muted svc-conn">asked by {entry.proposedBy.map((a) => a.name).join(", ") || "an agent"}</span>
        ) : names.length ? (
          <span className="svc-conn">
            <AvatarStack names={names} max={4} />
          </span>
        ) : (
          <span className="muted svc-conn">not connected</span>
        )}
      </div>
    </button>
  );
}
