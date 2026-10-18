import { isShopifyGrant, money, pctOf, shortHex } from "../format";
import { navigate } from "../route";
import type { AgentPublic } from "../types";
import { AgentAvatar, roleLabel, ServiceTile } from "./Avatar";
import { Plus, Snowflake, Sun } from "./Icons";

interface Props {
  agent: AgentPublic;
  showDetails: boolean;
  busy: boolean;
  onFreeze(): void;
  onUnfreeze(): void;
  /** Opens the Add money sheet. */
  onAddMoney(): void;
}

/** "claude-desktop" / "Claude Desktop" says the same thing twice. */
const showRole = (name: string) => roleLabel(name).toLowerCase().replace(/\s+/g, "-") !== name.toLowerCase();

export function AgentCard({ agent, showDetails, busy, onFreeze, onUnfreeze, onAddMoney }: Props) {
  const pct = pctOf(agent.spentToday, agent.policy.dailyCap);
  const meterClass = pct >= 90 ? "meter-danger" : pct >= 60 ? "meter-warn" : "";
  const services = agent.services ?? [];
  return (
    <article className={`agent-card${agent.frozen ? " agent-frozen" : ""}`} aria-busy={busy}>
      <header className="agent-head">
        <AgentAvatar name={agent.name} size="lg" badge={agent.frozen ? <Snowflake width={14} height={14} /> : undefined} />
        <div className="agent-title">
          <h3 className="agent-name">
            {agent.name} {showRole(agent.name) && <span className="agent-role">{roleLabel(agent.name)}</span>}
          </h3>
          <span className="agent-balance">{money(agent.balance)}</span>
        </div>
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
        <div className={`meter ${meterClass}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Spent today of daily cap">
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <dl className="agent-limits">
        <div><dt>Per payment</dt><dd>{money(agent.policy.maxPerTx)}</dd></div>
        <div><dt>Ask above</dt><dd>{money(agent.policy.approvalThreshold)}</dd></div>
        <div><dt>Earned</dt><dd className="earned">+{money(agent.earnedToday)}</dd></div>
      </dl>

      <div className="agent-services">
        <span className="agent-services-label">Services</span>
        {services.length === 0 ? (
          <span className="muted agent-services-none">none yet</span>
        ) : (
          <span className="agent-service-tiles">
            {services.map((s) => (
              <button key={s.id} className="tile-btn" title={`${s.name} (${s.pricing})`} onClick={() => navigate({ view: "services", serviceId: s.id })}>
                <ServiceTile name={s.name} color={s.color} size="sm" shopify={isShopifyGrant(s)} />
              </button>
            ))}
          </span>
        )}
      </div>

      {showDetails && (
        <div className="details">
          <code title={agent.address}>{shortHex(agent.address, 8, 6)}</code>
          <span className="muted">
            {agent.policy.allowlist
              ? `allowlist: ${[...agent.policy.allowlist.origins, ...agent.policy.allowlist.addresses.map((a) => shortHex(a))].join(", ") || "nothing (connected services only)"}`
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
        <button className="btn" onClick={onAddMoney} title={`Add test money to ${agent.name}`}>
          <Plus width={18} height={18} /> Add money
        </button>
      </div>
    </article>
  );
}
