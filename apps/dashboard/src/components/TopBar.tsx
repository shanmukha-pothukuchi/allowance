import { money } from "../format";
import { navigate, type Route } from "../route";
import type { DashboardState } from "../state";
import { Moon, Snowflake, Sun } from "./Icons";

interface Props {
  state: DashboardState;
  route: Route;
  theme: "dark" | "light";
  onToggleTheme(): void;
  onToggleDetails(): void;
}

const STATUS_LABEL: Record<DashboardState["connection"], string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  offline: "offline",
  demo: "demo data",
};

export function TopBar({ state, route, theme, onToggleTheme, onToggleDetails }: Props) {
  const frozen = state.agents.filter((a) => a.frozen);
  const pending = state.approvals.length;
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Allowance</span>
        </div>

        <nav className="tabs" aria-label="Views">
          <button className={`tab${route.view === "overview" ? " tab-on" : ""}`} aria-current={route.view === "overview" ? "page" : undefined} onClick={() => navigate({ view: "overview" })}>
            Overview
            {pending > 0 && <span className="tab-badge" title={`${pending} waiting for you`}>{pending}</span>}
          </button>
          <button className={`tab${route.view === "services" ? " tab-on" : ""}`} aria-current={route.view === "services" ? "page" : undefined} onClick={() => navigate({ view: "services" })}>
            Services
          </button>
        </nav>

        <div className="totals">
          <div className="total-balance">
            <span className="stat-label">Total balance</span>
            <span className="hero-number">{money(state.totals.totalBalance)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Spent today</span>
            <span className="stat-value">{money(state.totals.spentToday)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Earned today</span>
            <span className="stat-value earned">+{money(state.totals.earnedToday)}</span>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`live-pill live-${state.connection}`}>
            <span className="live-dot" aria-hidden />
            {STATUS_LABEL[state.connection]}
            {state.totals.chainMode !== "unknown" && <span className="pill-sub">{state.totals.chainMode === "mock" ? "mock ledger" : "Base Sepolia"}</span>}
          </span>
          {state.totals.telegramConnected && <span className="chain-pill">Telegram on</span>}
          <button className="icon-btn" onClick={onToggleTheme} title={theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? <Sun width={20} height={20} /> : <Moon width={20} height={20} />}
          </button>
          <label className="details-toggle">
            <input type="checkbox" checked={state.showDetails} onChange={onToggleDetails} />
            <span>details</span>
          </label>
        </div>
      </div>

      {state.connection === "offline" && (
        <div className="banner banner-warn">Wallet service is not reachable. Start it with npm run dev. Retrying every 2 seconds.</div>
      )}
      {state.connection === "demo" && (
        <div className="banner banner-warn">Demo data (?mock=1): nothing on this screen is real.</div>
      )}
      {state.lastError && <div className="banner banner-warn">{state.lastError}</div>}
      {frozen.length > 0 && (
        <div className="banner banner-danger" role="alert">
          <Snowflake />
          <span>
            <strong>{frozen.map((a) => a.name).join(", ")}</strong> {frozen.length === 1 ? "is" : "are"} frozen.
            {frozen[0].frozenReason ? ` ${frozen[0].frozenReason}` : ""}
          </span>
        </div>
      )}
    </header>
  );
}
