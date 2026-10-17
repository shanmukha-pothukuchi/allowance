import { money, pctOf, shortHex } from "../format";
import type { AgentPublic } from "../types";
import { Plus, Snowflake, Sun } from "./Icons";

interface Props {
  agent: AgentPublic;
  showDetails: boolean;
  busy: boolean;
  onFreeze(): void;
  onUnfreeze(): void;
  onTopup(): void;
}

export function AgentCard({ agent, showDetails, busy, onFreeze, onUnfreeze, onTopup }: Props) {
  const pct = pctOf(agent.spentToday, agent.policy.dailyCap);
  const meterClass = pct >= 90 ? "meter-danger" : pct >= 60 ? "meter-warn" : "";
  return (
    <article className={`agent-card${agent.frozen ? " agent-frozen" : ""}`} aria-busy={busy}>
      <header className="agent-head">
        <h3 className="agent-name">{agent.name}</h3>
        <span className="agent-balance">{money(agent.balance)}</span>
      </header>

      {agent.frozen && (
        <div className="frozen-badge" role="status">
          <Snowflake />
          <span>
            <strong>FROZEN</strong>
            {agent.frozenReason && <span className="frozen-reason">{agent.frozenReason}</span>}
          </span>
        </div>
      )}

      <div className="meter-row">
        <span className="meter-label">
          Spent today <strong>{money(agent.spentToday)}</strong> of {money(agent.policy.dailyCap)}
        </span>
        <div className={`meter ${meterClass}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <dl className="agent-limits">
        <div><dt>Max per payment</dt><dd>{money(agent.policy.maxPerTx)}</dd></div>
        <div><dt>Ask me above</dt><dd>{money(agent.policy.approvalThreshold)}</dd></div>
        <div><dt>Earned today</dt><dd className="earned">+{money(agent.earnedToday)}</dd></div>
      </dl>

      {showDetails && (
        <div className="details">
          <code title={agent.address}>{shortHex(agent.address, 8, 6)}</code>
          <span className="muted">
            {agent.policy.allowlist
              ? `allowlist: ${[...agent.policy.allowlist.origins, ...agent.policy.allowlist.addresses.map((a) => shortHex(a))].join(", ") || "nothing"}`
              : "no allowlist"}
          </span>
        </div>
      )}

      <div className="agent-actions">
        {agent.frozen ? (
          <button className="btn btn-primary" onClick={onUnfreeze} disabled={busy}>
            <Sun width={18} height={18} /> Unfreeze
          </button>
        ) : (
          <button className="btn" onClick={onFreeze} disabled={busy}>
            <Snowflake width={18} height={18} /> Freeze
          </button>
        )}
        <button className="btn" onClick={onTopup} disabled={busy}>
          <Plus width={18} height={18} /> Add $20 (demo)
        </button>
      </div>
    </article>
  );
}
