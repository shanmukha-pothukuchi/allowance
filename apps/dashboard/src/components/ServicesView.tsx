/** The Services tab: a Muse-style connectors gallery over the directory plus agent-proposed services. */
import { useMemo, useState } from "react";
import { navigate } from "../route";
import { buildCatalog, CATEGORIES, filterCatalog, requestsFor, withProposals, type CatalogEntry, type CategoryFilter } from "../services";
import type { DashboardState } from "../state";
import type { WalletActions } from "../useWallet";
import { AvatarStack, ServiceTile } from "./Avatar";
import { Search, Warn } from "./Icons";
import { ServiceSheet } from "./ServiceSheet";

interface Props {
  state: DashboardState;
  actions: WalletActions;
  selectedId?: string;
  now: number;
}

export function ServicesView({ state, actions, selectedId, now }: Props) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryFilter>("all");
  const catalog = useMemo(() => withProposals(buildCatalog(state.directory, state.agents), state.approvals, state.agents), [state.directory, state.agents, state.approvals]);
  const shown = useMemo(() => filterCatalog(catalog, q, cat), [catalog, q, cat]);
  const selected = selectedId ? catalog.find((e) => e.service.id === selectedId) : undefined;
  const connectedTotal = catalog.reduce((n, e) => n + e.connections.length, 0);

  return (
    <main className="services-view">
      <div className="services-head">
        <div className="services-title">
          <h1>Services</h1>
          <p className="muted">
            Agents can only pay services they are connected to. {connectedTotal} connection{connectedTotal === 1 ? "" : "s"} across {state.agents.length} agents.
          </p>
        </div>
        <label className="search">
          <Search width={20} height={20} />
          <input type="search" placeholder="Search services" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" />
        </label>
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
  return (
    <button className={`svc-card${entry.custom ? " svc-card-custom" : ""}${waiting ? " svc-card-waiting" : ""}`} onClick={onOpen}>
      <div className="svc-card-top">
        <ServiceTile icon={s.icon} color={s.color} size="xl" />
        <div className="svc-badges">
          {waiting > 0 && <span className="badge badge-warn">{waiting} waiting for you</span>}
          {entry.custom && <span className="badge badge-custom">Proposed by {entry.proposedBy.map((a) => a.name).join(", ") || "an agent"}</span>}
          {entry.builtIn && <span className="badge">Built in</span>}
        </div>
      </div>
      <h3 className="svc-name">{s.name}</h3>
      <p className="svc-provider">{entry.custom ? s.provider : `by ${s.provider}`}</p>
      <p className="svc-summary">{s.summary}</p>
      <div className="svc-card-foot">
        <span className="svc-price">{s.pricing}</span>
        {entry.builtIn ? (
          <span className="muted svc-conn">every agent</span>
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
