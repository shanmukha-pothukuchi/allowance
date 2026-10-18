/**
 * The Services view (docs/ui-rules.md D5): one header with the one primary action (Add service,
 * §18), a quiet filter, and every service as a grouped Linear row: directory entries, Shopify
 * stores (their meta is the storefront domain), APIs added by link and agent proposals alike.
 */
import { useMemo, useState } from "react";
import { navigate } from "../route";
import { buildCatalog, CATEGORIES, filterCatalog, requestsFor, withProposals, type CatalogEntry, type CategoryFilter } from "../services";
import { toCents } from "../format";
import { shortMoney } from "../sheets";
import { shopifyRefOf, storefrontHost } from "../shopify";
import type { DashboardState } from "../state";
import type { WalletActions } from "../useWallet";
import { AvatarStack, ServiceTile } from "./Avatar";
import { Plus, Search, Warn } from "./Icons";
import { ServiceSheet } from "./ServiceSheet";

interface Props {
  state: DashboardState;
  actions: WalletActions;
  selectedId?: string;
  now: number;
  /** Open "Add service" (§18): pick from the directory or paste any link. */
  onAddService(): void;
}

export function ServicesView({ state, actions, selectedId, now, onAddService }: Props) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryFilter>("all");
  const catalog = useMemo(() => withProposals(buildCatalog(state.directory, state.agents), state.approvals, state.agents), [state.directory, state.agents, state.approvals]);
  const shown = useMemo(() => filterCatalog(catalog, q, cat), [catalog, q, cat]);
  const selected = selectedId ? catalog.find((e) => e.service.id === selectedId) : undefined;
  const connectedTotal = catalog.reduce((n, e) => n + e.connections.length, 0);
  // "All" groups the rows by category, like Linear groups issues by status.
  const groups = useMemo(() => {
    if (cat !== "all") return [{ id: cat, label: "", entries: shown }];
    return CATEGORIES.filter((c) => c.id !== "all")
      .map((c) => ({ id: c.id, label: c.label, entries: shown.filter((e) => e.service.category === c.id) }))
      .concat([{ id: "other" as CategoryFilter, label: "Other", entries: shown.filter((e) => !CATEGORIES.some((c) => c.id !== "all" && c.id === e.service.category)) }])
      .filter((g) => g.entries.length > 0);
  }, [shown, cat]);

  return (
    <main className="services-view">
      <header className="services-head">
        <div className="services-title">
          <h1>Services</h1>
          <p className="muted">
            Agents only pay services they're connected to · {connectedTotal} connection{connectedTotal === 1 ? "" : "s"}
          </p>
        </div>
        <div className="services-actions">
          <label className="search">
            <Search width={15} height={15} />
            <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" />
          </label>
          <button type="button" className="btn btn-primary btn-sm" onClick={onAddService}>
            <Plus width={14} height={14} /> Add service
          </button>
        </div>
      </header>

      <div className="seg services-seg" role="tablist" aria-label="Category">
        {CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} className={cat === c.id ? "seg-on" : ""} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="services-scroll">
        {state.directoryStatus === "error" && (
          <div className="directory-error">
            <Warn width={15} height={15} />
            <span>{state.directoryError ?? "The service directory is not reachable."} Services your agents already have still show below.</span>
            <button className="btn btn-sm" onClick={() => void actions.reloadDirectory()}>
              Retry
            </button>
          </div>
        )}
        {state.directoryStatus === "idle" && catalog.length === 0 && <p className="empty">Waiting for the wallet service…</p>}
        {state.directoryStatus === "loading" && catalog.length === 0 && <p className="empty">Loading the directory…</p>}
        {state.directoryStatus === "ready" && shown.length === 0 && <p className="empty">No services match{q ? ` “${q}”` : ""}.</p>}
        {groups.map((g) => (
          <section key={g.id} className="svc-group" aria-label={g.label || undefined}>
            {g.label && (
              <h2 className="svc-group-head">
                {g.label} <span className="muted">{g.entries.length}</span>
              </h2>
            )}
            <ul className="svc-list">
              {g.entries.map((e) => (
                <li key={e.service.id}>
                  <ServiceRow entry={e} waiting={requestsFor(state.approvals, e.service.id).length} onOpen={() => navigate({ view: "services", serviceId: e.service.id })} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {selected && <ServiceSheet entry={selected} state={state} actions={actions} now={now} onClose={() => navigate({ view: "services" })} />}
    </main>
  );
}

function ServiceRow({ entry, waiting, onOpen }: { entry: CatalogEntry; waiting: number; onOpen(): void }) {
  const s = entry.service;
  const names = entry.connections.map((c) => c.agent.name);
  const shop = shopifyRefOf(s);
  const who = shop ? storefrontHost(shop) : s.provider;
  const price = shop ? (toCents(s.maxPrice) > 0 ? `Up to ${shortMoney(s.maxPrice)} per order` : "No cap") : s.pricing;
  return (
    <button type="button" className={`svc-row${entry.custom ? " svc-row-custom" : ""}`} onClick={onOpen}>
      <ServiceTile name={s.name} color={s.color} size="xs" shopify={!!shop} />
      <span className="svc-row-main">
        <span className="svc-row-name">{s.name}</span>
        <span className="svc-row-meta">
          {who}
          {s.summary && <span className="svc-row-sum"> · {s.summary}</span>}
        </span>
      </span>
      <span className="svc-row-marks">
        {waiting > 0 && <span className="ln-chip ln-chip-warn">Pending</span>}
        {entry.custom && <span className="ln-chip ln-chip-custom" title={`Proposed by ${entry.proposedBy.map((a) => a.name).join(", ") || "an agent"}`}>Proposed</span>}
      </span>
      <span className="svc-row-price">{price}</span>
      <span className="svc-row-conn">
        {entry.builtIn ? <span className="muted">Every agent</span> : names.length ? <AvatarStack names={names} max={4} /> : <span className="muted">—</span>}
      </span>
    </button>
  );
}
