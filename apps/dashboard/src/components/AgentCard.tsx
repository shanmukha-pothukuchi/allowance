import type { MouseEvent } from "react";
import { masked } from "../bank";
import { isShopifyGrant, money, pctOf, shortHex } from "../format";
import { shortMoney } from "../sheets";
import type { AgentPublic, BankAccountView } from "../types";
import { AgentAvatar, roleLabel, ServiceTile } from "./Avatar";
import { Plus, Snowflake } from "./Icons";

interface Props {
  agent: AgentPublic;
  showDetails: boolean;
  busy: boolean;
  onFreeze(): void;
  onUnfreeze(): void;
  /** Opens the Add money sheet. */
  onAddMoney(): void;
  /** Its Capital One allowance account (§16), once the bank opened one. Absent: no bank meta at all. */
  bankAccount?: Pick<BankAccountView, "last4" | "balance">;
  /** Opens the agent's detail (account, statement, services, receipts). */
  onOpen?(): void;
}

/** "claude-desktop" / "Claude Desktop" says the same thing twice. */
const showRole = (name: string) => roleLabel(name).toLowerCase().replace(/\s+/g, "-") !== name.toLowerCase();

const MAX_TILES = 4;

/**
 * One agent as a Linear list row (docs/ui-rules.md D4): name and role, one muted meta line (limits
 * and its bank account), its services as a small icon stack, today's spend as a quiet bar, the
 * balance once, and quiet icon actions. The row opens the agent's detail.
 */
export function AgentCard({ agent, showDetails, busy, onFreeze, onUnfreeze, onAddMoney, bankAccount, onOpen }: Props) {
  const pct = pctOf(agent.spentToday, agent.policy.dailyCap);
  const meterClass = pct >= 90 ? "meter-danger" : pct >= 60 ? "meter-warn" : "";
  const services = (agent.services ?? []).filter((s) => s.id !== "directory");
  const tiles = services.slice(0, MAX_TILES);
  const earned = Number(agent.earnedToday) > 0;
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <li className={`agent-row${agent.frozen ? " agent-frozen" : ""}${onOpen ? " agent-row-open" : ""}`} aria-busy={busy} onClick={onOpen}>
      <AgentAvatar name={agent.name} size="sm" badge={agent.frozen ? <Snowflake width={10} height={10} /> : undefined} />

      <div className="agent-who">
        <p className="agent-name">
          <button type="button" className="agent-open" onClick={onOpen && stop(onOpen)} title={`Open ${agent.name}`}>
            {agent.name}
          </button>
          {showRole(agent.name) && <span className="agent-role">{roleLabel(agent.name)}</span>}
          {services.length > 0 && (
          <span className="agent-stack" title={`Connected: ${services.map((s) => s.name).join(", ")}`} aria-label={`${services.length} services connected`}>
            {tiles.map((s) => (
              <ServiceTile key={s.id} name={s.name} color={s.color} size="xs" shopify={isShopifyGrant(s)} />
            ))}
            {services.length > MAX_TILES && <span className="svc-tile svc-tile-xs svc-tile-more">+{services.length - MAX_TILES}</span>}
          </span>
          )}
        </p>
        {agent.frozen ? (
          <p className="agent-sub agent-sub-frozen">
            <span title={agent.frozenReason}>Frozen by your wallet</span>
            {" · "}
            <button type="button" className="agent-unfreeze" onClick={stop(onUnfreeze)} disabled={busy} aria-label={`Unfreeze ${agent.name}`}>
              Unfreeze
            </button>
          </p>
        ) : (
          <p className="agent-sub" title={`Max ${money(agent.policy.maxPerTx)} per payment · asks you above ${money(agent.policy.approvalThreshold)} · ${money(agent.policy.dailyCap)} a day`}>
            {bankAccount && (
              <span className="agent-bank" title={`Capital One allowance account ${masked(bankAccount.last4)} (Nessie sandbox)`}>
                Capital One {masked(bankAccount.last4)}
                {" · "}
              </span>
            )}
            Asks above {shortMoney(agent.policy.approvalThreshold)}
          </p>
        )}
        {showDetails && (
          <code className="agent-addr" title={agent.address}>
            {shortHex(agent.address, 8, 6)}
          </code>
        )}
      </div>


      <div className="agent-today" title={`Spent today: ${money(agent.spentToday)} of ${money(agent.policy.dailyCap)} a day`}>
        <span className="agent-today-text">
          {money(agent.spentToday)} <span className="muted">/ {shortMoney(agent.policy.dailyCap)}</span>
        </span>
        <div className={`meter ${meterClass}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${agent.name}: spent today of daily cap`}>
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="agent-money">
        <span className="agent-balance">{money(agent.balance)}</span>
        {earned && <span className="agent-earned">+{money(agent.earnedToday)} today</span>}
      </div>

      <div className="agent-actions">
        {/* Frozen: Unfreeze sits in the meta line, said once. */}
        {!agent.frozen && (
          <button className="row-btn" onClick={stop(onFreeze)} disabled={busy} title={`Freeze ${agent.name}`} aria-label={`Freeze ${agent.name}`}>
            <Snowflake width={15} height={15} />
          </button>
        )}
        <button className="row-btn" onClick={stop(onAddMoney)} title={`Add money to ${agent.name}`} aria-label={`Add money to ${agent.name}`}>
          <Plus width={15} height={15} />
        </button>
      </div>
    </li>
  );
}
