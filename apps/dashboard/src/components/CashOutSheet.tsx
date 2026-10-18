/**
 * "Cash out" (§20.2, `/?sheet=cash-out&agent=<name>`, dashboard only): move an agent's USDC back to
 * the owner, `POST /v1/agents/:id/cashout { amount | "all" }`. With Capital One linked the same
 * dollars land in checking. Works while the agent is frozen. Positions stay invested: only cash moves.
 */
import { useState } from "react";
import type { WalletAdapter } from "../api/adapter";
import { masked, SANDBOX_NOTE } from "../bank";
import { money, shortHex, toCents } from "../format";
import { cashoutLine, checkCashout } from "../invest";
import { shortAgo } from "../lines";
import { shortMoney } from "../sheets";
import type { AgentPublic, Receipt, SummaryResponse } from "../types";
import { useNow } from "../useWallet";
import { AgentAvatar } from "./Avatar";
import { BankTile } from "./BankParts";
import { Check, Snowflake } from "./Icons";
import { LineText } from "./Lines";
import { Field, SheetShell } from "./SheetParts";

const CHIPS = ["5.00", "10.00", "20.00"];

interface Props {
  adapter: WalletAdapter | null;
  agent: AgentPublic | undefined;
  agentName: string;
  /** The owner's checking, from the summary (§16.4). */
  bank: SummaryResponse["bank"] | null;
  /** What it holds in paper positions (they stay invested). */
  invested?: string;
  onClose(): void;
  onDone(): void;
}

export function CashOutSheet({ adapter, agent, agentName, bank, invested, onClose, onDone }: Props) {
  const [choice, setChoice] = useState<string>("all");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Receipt | null>(null);
  const now = useNow(5000);
  const linked = !!bank?.linked;
  const last4 = linked ? bank?.checkingLast4 : undefined;
  const balance = agent?.balance ?? "0.00";
  const check = checkCashout(choice, custom, balance);
  // The balance is said once, in the header: the chip and the button say "all".
  const amountText = check.ok ? (check.amount === "all" ? "all" : shortMoney(check.amount)) : "";

  const cashOut = async () => {
    if (!adapter || !agent) return;
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await adapter.cashout(agent.id, check.amount);
      setDone(r);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const head = (
    <div className="osheet-title">
      {agent && <AgentAvatar name={agent.name} size="sm" badge={agent.frozen ? <Snowflake width={10} height={10} /> : undefined} />}
      <div className="osheet-titles">
        <h2 className="osheet-name">Cash out {agent?.name ?? agentName}</h2>
        <p className="osheet-sub">{agent ? `Balance ${money(balance)}` : "Not in the wallet"}</p>
      </div>
    </div>
  );

  if (done && agent) {
    return (
      <SheetShell embed={false} label={`Cashed out ${agent.name}`} head={head} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="done-line" role="status">
          <span className="done-check" aria-hidden>
            <Check width={14} height={14} />
          </span>
          <div className="co-receipt">
            <LineText line={{ ...cashoutLine(agent.name, done.amount, last4), actor: undefined, verb: "Cashed out" }} time={shortAgo(done.settledAt ?? done.createdAt, now)} />
            {done.txHash && (
              <p className="ln-details">
                {done.explorerUrl ? (
                  <a href={done.explorerUrl} target="_blank" rel="noopener noreferrer" title={done.txHash}>
                    tx {shortHex(done.txHash)}
                  </a>
                ) : (
                  <code title={done.txHash}>tx {shortHex(done.txHash)}</code>
                )}
              </p>
            )}
          </div>
        </div>
      </SheetShell>
    );
  }

  const footer = agent && (
    <>
      {error && (
        <p className="field-error osheet-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void cashOut()} disabled={busy || !adapter || toCents(balance) < 1}>
        {busy ? "Cashing out…" : amountText ? `Cash out ${amountText}` : "Cash out"}
      </button>
    </>
  );

  return (
    <SheetShell embed={false} label={`Cash out ${agentName}`} head={head} footer={footer} locked={busy} onClose={onClose}>
      {!agent && <p className="muted">No agent named {agentName}.</p>}
      {agent && (
        <>
          <Field label="To">
            <ul className="ln-group">
              <li className="grow" title={linked ? SANDBOX_NOTE : "The owner's address in the wallet"}>
                {linked ? <BankTile size="xs" /> : null}
                <span className="grow-main">
                  <span className="grow-title">{linked ? `Capital One Checking ${masked(last4)}` : "You (the owner vault)"}</span>
                </span>
                {linked && bank?.checkingBalance !== undefined && (
                  <span className="grow-meta">
                    <span className="grow-amt">{money(bank.checkingBalance)}</span>
                  </span>
                )}
              </li>
            </ul>
          </Field>
          <Field label="Amount" hint={invested && toCents(invested) > 0 ? `${money(invested)} in positions stays invested.` : undefined}>
            <div className="amount-picker">
              <div className="chips amount-chips" role="radiogroup" aria-label="Amount">
                <button type="button" role="radio" aria-checked={choice === "all"} className={`chip amount-chip${choice === "all" ? " chip-on" : ""}`} onClick={() => setChoice("all")}>
                  All
                </button>
                {CHIPS.filter((c) => toCents(c) < toCents(balance)).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={choice === c} className={`chip amount-chip${choice === c ? " chip-on" : ""}`} onClick={() => setChoice(c)}>
                    {shortMoney(c)}
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={choice === "custom"} className={`chip amount-chip${choice === "custom" ? " chip-on" : ""}`} onClick={() => setChoice("custom")}>
                  Custom
                </button>
              </div>
              {choice === "custom" && (
                <div className={`money-input${custom && !check.ok ? " input-bad" : ""}`}>
                  <span aria-hidden>$</span>
                  <input
                    autoFocus
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={custom}
                    aria-label="Amount to cash out, in dollars"
                    onChange={(e) => {
                      setCustom(e.target.value);
                      setError(undefined);
                    }}
                  />
                </div>
              )}
              {choice === "custom" && custom && !check.ok && (
                <p className="field-error" role="alert">
                  {check.message}
                </p>
              )}
            </div>
          </Field>
        </>
      )}
    </SheetShell>
  );
}
