import { masked } from "../bank";
import { isShopifyGrant, money, pctOf, shortHex } from "../format";
import { navigate } from "../route";
import type { AgentPublic, BankAccountView } from "../types";
import { AgentAvatar, roleLabel, ServiceTile } from "./Avatar";
import { Bank, Plus, Snowflake, Sun } from "./Icons";

interface Props {
  agent: AgentPublic;
  showDetails: boolean;
  busy: boolean;
  onFreeze(): void;
  onUnfreeze(): void;
  /** Opens the Add money sheet. */
  onAddMoney(): void;
  /** Its Capital One allowance account (§16), once the bank opened one. Absent: no bank line at all. */
  bankAccount?: Pick<BankAccountView, "last4" | "balance">;
  /** Opens the agent's detail (account and statement). */
  onOpenBank?(): void;
}

/** "claude-desktop" / "Claude Desktop" says the same thing twice. */
const showRole = (name: string) => roleLabel(name).toLowerCase().replace(/\s+/g, "-") !== name.toLowerCase();

/** One agent as a row of the Agents list: who, today's spend against its cap, balance, actions. */
export function AgentCard({ agent, showDetails, busy, onFreeze, onUnfreeze, onAddMoney, bankAccount, onOpenBank }: Props) {
  const pct = pctOf(agent.spentToday, agent.policy.dailyCap);
  const meterClass = pct >= 90 ? "meter-danger" : pct >= 60 ? "meter-warn" : "";
  const services = agent.services ?? [];
  const earned = Number(agent.earnedToday) > 0;
  return (
    <li className={`agent-row${agent.frozen ? " agent-frozen" : ""}`} aria-busy={busy}>
      <AgentAvatar name={agent.name} size="md" badge={agent.frozen ? <Snowflake width={12} height={12} /> : undefined} />

      <div className="agent-who">
        <div className="agent-name">
          {agent.name}
          {showRole(agent.name) && <span className="agent-role">{roleLabel(agent.name)}</span>}
        </div>
        {agent.frozen ? (
          <>
            <div className="agent-sub agent-sub-frozen">Frozen by your wallet{agent.frozenReason ? ` · ${agent.frozenReason}` : ""}</div>
            <button className="btn btn-primary btn-sm agent-unfreeze" onClick={onUnfreeze} disabled={busy}>
              <Sun width={15} height={15} /> Unfreeze
            </button>
          </>
        ) : (
          <div className="agent-sub">
            Max {money(agent.policy.maxPerTx)} · asks above {money(agent.policy.approvalThreshold)}
          </div>
        )}
        {(services.length > 0 || bankAccount) && (
          <span className="agent-service-tiles" aria-label="Connected services">
            {services.map((s) => (
              <button key={s.id} className="tile-btn" title={`${s.name} (${s.pricing})`} onClick={() => navigate({ view: "services", serviceId: s.id })}>
                <ServiceTile name={s.name} color={s.color} size="xs" shopify={isShopifyGrant(s)} />
              </button>
            ))}
            {bankAccount && (
              <button type="button" className="agent-bank" onClick={onOpenBank} title={`Capital One allowance account ${masked(bankAccount.last4)} (Nessie sandbox). Open its statement.`}>
                <Bank width={13} height={13} />
                <span>Capital One {masked(bankAccount.last4)}</span>
                <span className="agent-bank-bal">{money(bankAccount.balance)}</span>
              </button>
            )}
          </span>
        )}
        {showDetails && (
          <code className="agent-addr" title={agent.address}>
            {shortHex(agent.address, 8, 6)}
          </code>
        )}
      </div>

      <div className="agent-today">
        <span className="agent-today-text">
          {money(agent.spentToday)} <span className="muted">of {money(agent.policy.dailyCap)}</span>
        </span>
        <div className={`meter ${meterClass}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${agent.name}: spent today of daily cap`}>
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="agent-money">
        <span className="agent-balance">{money(agent.balance)}</span>
        {earned && <span className="agent-earned earned">+{money(agent.earnedToday)} today</span>}
      </div>

      <div className="agent-actions">
        {!agent.frozen && (
          <button className="row-btn" onClick={onFreeze} disabled={busy} title={`Freeze ${agent.name}`} aria-label={`Freeze ${agent.name}`}>
            <Snowflake width={16} height={16} />
          </button>
        )}
        <button className="row-btn" onClick={onAddMoney} title={`Add test money to ${agent.name}`} aria-label={`Add money to ${agent.name}`}>
          <Plus width={16} height={16} />
        </button>
      </div>
    </li>
  );
}
