import { checkingLine } from "../bank";
import { money } from "../format";
import { navigate, type Route } from "../route";
import type { DashboardState } from "../state";
import { Bank, Moon, Snowflake, Sun } from "./Icons";

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
  /** Opens the Capital One sheet (§16.5). */
  onOpenBank?(): void;
}

/** The owner's console navigation: a quiet left rail (brand, views, linked bank, connection, preferences). */
export function SideNav({ state, route, theme, onToggleTheme, onToggleDetails, onOpenBank }: NavProps) {
  const pending = state.approvals.length;
  // §16.5: the owner's checking, only once the bank is linked. Without a Nessie key, nothing.
  const bank = state.totals.bank?.linked ? state.totals.bank : null;
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
      <nav className="nav-list" aria-label="Views">
        {item("overview", "Overview", pending)}
        {item("services", "Services")}
      </nav>

      {bank && (
        <div className="nav-section">
          <p className="nav-section-title">Linked bank</p>
          <button
            type="button"
            className="nav-bank"
            onClick={onOpenBank}
            title={`${checkingLine(bank)}. Capital One's Nessie sandbox: sandbox money, not real dollars.`}
            aria-label={`${checkingLine(bank)}, Nessie sandbox. Open the bank.`}
          >
            <span className="nav-bank-ic" aria-hidden>
              <Bank width={14} height={14} />
            </span>
            <span className="nav-bank-text">Capital One</span>
            <span className="nav-bank-amt">{bank.checkingBalance !== undefined ? money(bank.checkingBalance) : "—"}</span>
          </button>
        </div>
      )}

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
            {theme === "dark" ? <Sun width={15} height={15} /> : <Moon width={15} height={15} />}
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
            {frozen.length === 1 && frozen[0].frozenReason ? <span className="banner-sub"> {frozen[0].frozenReason.replace(/\s*Agent frozen\.?\s*$/i, "")}</span> : null}
          </span>
        </div>
      )}
    </>
  );
}
