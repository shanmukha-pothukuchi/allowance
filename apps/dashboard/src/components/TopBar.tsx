import { money } from "../format";
import type { DashboardState } from "../state";
import { Snowflake } from "./Icons";

interface Props {
  state: DashboardState;
  onToggleDetails(): void;
}

const STATUS_LABEL: Record<DashboardState["connection"], string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  offline: "offline",
  demo: "demo data",
};

export function TopBar({ state, onToggleDetails }: Props) {
  const frozen = state.agents.filter((a) => a.frozen);
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Allowance</span>
          <span className={`live-pill live-${state.connection}`}>
            <span className="live-dot" aria-hidden />
            {STATUS_LABEL[state.connection]}
          </span>
          {state.totals.chainMode !== "unknown" && (
            <span className="chain-pill">{state.totals.chainMode === "mock" ? "mock ledger" : "Base Sepolia"}</span>
          )}
          {state.totals.telegramConnected && <span className="chain-pill">Telegram on</span>}
        </div>

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
