/**
 * The Portfolio view (§20.4): every agent's paper positions, grouped by agent like Linear groups
 * issues. The page head says the totals and the replay date once; each group head says its agent's
 * own totals (only when there is more than one agent, so nothing is said twice). Figures are
 * tabular and right-aligned; green and red only on the P/L signs.
 */
import { paperLine, pnlTone, shares, signedMoney, signedPct, sumPortfolios, tradingDay, type AgentPortfolio, type Position } from "../invest";
import { money } from "../format";
import type { Loadable } from "../useInvest";
import type { Portfolios } from "../invest";
import { AgentAvatar } from "./Avatar";
import { CashOut, Warn } from "./Icons";

interface Props {
  portfolios: Loadable<Portfolios>;
  onRetry(): void;
  onCashOut(agentName: string): void;
  onOpenAgent(agentName: string): void;
}

function Pnl({ amount, pct }: { amount: string; pct?: number }) {
  const tone = pnlTone(amount);
  return (
    <span className={`pf-pnl pnl-${tone}`}>
      {signedMoney(amount)}
      {pct !== undefined && <span className="pf-pct">{signedPct(pct)}</span>}
    </span>
  );
}

function PositionRow({ p }: { p: Position }) {
  return (
    <li className="pf-row">
      <span className="pf-tk">
        <strong>{p.ticker}</strong>
        {p.name && <span className="pf-name">{p.name}</span>}
      </span>
      <span className="pf-num pf-shares" title={`${p.shares} shares`}>
        {shares(p.shares)}
      </span>
      <span className="pf-num pf-avg">{money(p.avgCost)}</span>
      <span className="pf-num pf-price">{money(p.price)}</span>
      <span className="pf-num pf-value">{money(p.value)}</span>
      <span className="pf-num pf-pl">
        <Pnl amount={p.unrealizedPnl} pct={p.unrealizedPct} />
      </span>
      {/* narrow screens: shares, cost and price as one muted line */}
      <span className="pf-sub">
        {shares(p.shares)} sh · avg {money(p.avgCost)} · {money(p.price)}
      </span>
    </li>
  );
}

function AgentGroup({ p, showTotals, onCashOut, onOpenAgent }: { p: AgentPortfolio; showTotals: boolean; onCashOut(): void; onOpenAgent(): void }) {
  const sum = sumPortfolios([p]);
  const realized = Number(p.totals.realizedPnl) !== 0;
  return (
    <section className="pf-group" aria-label={`${p.agentName} positions`}>
      <header className="pf-group-head">
        <span className="pf-head-main">
          <button type="button" className="pf-who" onClick={onOpenAgent} title={`Open ${p.agentName}`}>
            <AgentAvatar name={p.agentName} size="xs" />
            <span className="pf-agent">{p.agentName}</span>
          </button>
          {showTotals && realized && (
            <span className="pf-meta">
              Realized <Pnl amount={p.totals.realizedPnl} />
            </span>
          )}
          <button type="button" className="btn btn-sm btn-quiet pf-cash" onClick={onCashOut} title={`Move ${p.agentName}'s cash back to you`}>
            <CashOut width={14} height={14} /> Cash out
          </button>
        </span>
        {showTotals && p.positions.length > 0 && (
          <>
            <span className="pf-num pf-value pf-head-value">{money(sum.value)}</span>
            <span className="pf-num pf-pl pf-head-pl">
              <Pnl amount={sum.unrealizedPnl} pct={sum.unrealizedPct} />
            </span>
          </>
        )}
      </header>
      {p.positions.length === 0 ? (
        <p className="pf-none">No open positions.</p>
      ) : (
        <ul className="pf-rows">
          {p.positions.map((x) => (
            <PositionRow key={x.ticker} p={x} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function PortfolioView({ portfolios, onRetry, onCashOut, onOpenAgent }: Props) {
  const data = portfolios.state === "ready" ? portfolios.data : portfolios.state === "error" ? portfolios.data : undefined;
  const list = [...(data?.portfolios ?? [])].sort((a, b) => Number(b.totals.value) - Number(a.totals.value) || a.agentName.localeCompare(b.agentName));
  const sum = sumPortfolios(list);
  const b = data?.brokerage;
  return (
    <main className="overview pf-view">
      <header className="page-head">
        <div className="balance-block">
          <span className="eyebrow">Portfolio value</span>
          <span className="balance">{money(sum.value)}</span>
          <span className="balance-sub">{paperLine(b)}</span>
        </div>
        <dl className="kpis">
          <div>
            <dt>Unrealized</dt>
            <dd>
              <Pnl amount={sum.unrealizedPnl} pct={sum.positions ? sum.unrealizedPct : undefined} />
            </dd>
          </div>
          <div>
            <dt>Realized</dt>
            <dd>
              <Pnl amount={sum.realizedPnl} />
            </dd>
          </div>
          <div>
            <dt>Replay date</dt>
            <dd title={b?.mode === "live" ? "The latest real close" : "The brokerage replays real daily closes, one trading day every few seconds"}>{tradingDay(b?.clockDate) || "—"}</dd>
          </div>
        </dl>
      </header>

      {portfolios.state === "error" && (
        <div className="directory-error" role="alert">
          <Warn width={15} height={15} />
          <span>{portfolios.message}</span>
          <button className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      <div className="pf-list">
        {portfolios.state === "loading" && <p className="empty">Loading the brokerage…</p>}
        {data && list.length === 0 && <p className="empty">No positions yet.</p>}
        {list.length > 0 && (
          <div className="pf-cols" aria-hidden>
            <span>Position</span>
            <span>Shares</span>
            <span>Avg cost</span>
            <span>Price</span>
            <span>Value</span>
            <span>P/L</span>
          </div>
        )}
        {list.map((p) => (
          <AgentGroup key={p.agentName} p={p} showTotals={list.length > 1} onCashOut={() => onCashOut(p.agentName)} onOpenAgent={() => onOpenAgent(p.agentName)} />
        ))}
      </div>
    </main>
  );
}
