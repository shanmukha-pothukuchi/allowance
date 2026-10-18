import { navigate, type Route } from "../route";
import type { DashboardState } from "../state";
import { Moon, Snowflake, Sun } from "./Icons";

const STATUS_LABEL: Record<DashboardState["connection"], string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
  demo: "Demo data",
};

interface NavProps {
  state: DashboardState;
  route: Route;
  theme: "dark" | "light";
  onToggleTheme(): void;
  onToggleDetails(): void;
}

/** The owner's console navigation: a quiet left rail (brand, views, connection, preferences). */
export function SideNav({ state, route, theme, onToggleTheme, onToggleDetails }: NavProps) {
  const pending = state.approvals.length;
  const item = (view: Route["view"], label: string, badge?: number) => (
    <button className={`nav-item${route.view === view ? " nav-on" : ""}`} aria-current={route.view === view ? "page" : undefined} onClick={() => navigate({ view })}>
      <span>{label}</span>
      {!!badge && <span className="nav-badge" title={`${badge} waiting for you`}>{badge}</span>}
    </button>
  );
  return (
    <aside className="sidenav" aria-label="Wallet">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">Allowance</span>
      </div>
      <p className="nav-caption">Owner's wallet</p>
      <nav className="nav-list" aria-label="Views">
        {item("overview", "Overview", pending)}
        {item("services", "Services")}
      </nav>

      <div className="nav-foot">
        <span className={`live-pill live-${state.connection}`}>
          <span className="live-dot" aria-hidden />
          {STATUS_LABEL[state.connection]}
          {state.totals.chainMode !== "unknown" && <span className="pill-sub">{state.totals.chainMode === "mock" ? "mock ledger" : "Base Sepolia"}</span>}
        </span>
        {state.totals.telegramConnected && <span className="nav-note">Telegram approvals on</span>}
        <div className="nav-prefs">
          <label className="details-toggle">
            <input type="checkbox" checked={state.showDetails} onChange={onToggleDetails} />
            <span>Technical details</span>
          </label>
          <button className="icon-btn" onClick={onToggleTheme} title={theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? <Sun width={18} height={18} /> : <Moon width={18} height={18} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Connection problems and frozen agents, across the top of the page. */
export function Banners({ state }: { state: DashboardState }) {
  const frozen = state.agents.filter((a) => a.frozen);
  return (
    <>
      {state.connection === "offline" && <div className="banner banner-warn">Wallet service is not reachable. Start it with npm run dev. Retrying every 2 seconds.</div>}
      {state.connection === "demo" && <div className="banner banner-warn">Demo data (?mock=1): nothing on this screen is real.</div>}
      {state.lastError && <div className="banner banner-warn">{state.lastError}</div>}
      {frozen.length > 0 && (
        <div className="banner banner-danger" role="alert">
          <Snowflake />
          <span>
            <strong>{frozen.map((a) => a.name).join(", ")}</strong> {frozen.length === 1 ? "is" : "are"} frozen.
            {frozen.length === 1 && frozen[0].frozenReason ? <span className="banner-sub"> {frozen[0].frozenReason}</span> : null}
          </span>
        </div>
      )}
    </>
  );
}
