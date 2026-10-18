/**
 * "Add money" (§14.3): test money for one agent on the mock ledger. `POST /v1/agents/:id/topup`.
 * With Capital One linked (§16.5) the dollars move from the owner's checking to the agent's
 * allowance account first; the bank's two refusals are shown in its own words.
 */
import { useCallback, useEffect, useState } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { bankMarker, bankNote, masked, movedLine, SANDBOX_NOTE, short, topupBankError } from "../bank";
import { addDollars, money, shortHex, toCents } from "../format";
import { receiptAmount, shortAgo } from "../lines";
import { parseAmount, shortMoney, type AmountCheck } from "../sheets";
import type { AgentPublic, Receipt, SummaryResponse } from "../types";
import { useNow } from "../useWallet";
import { AgentAvatar } from "./Avatar";
import { BankTile } from "./BankParts";
import { ArrowOut, Check, Snowflake } from "./Icons";
import { BankLine, BankProblem, LineRow } from "./Lines";
import { AmountPicker, CopyField, CUSTOM, Field, SheetShell } from "./SheetParts";

interface Props {
  adapter: WalletAdapter | null;
  offline?: boolean;
  embed: boolean;
  /** From `&agent=<name>`. Missing or unknown → pick one here. */
  agentName?: string;
  showDetails?: boolean;
  onClose(): void;
  onAdded?(name: string, amount: string): void;
}

interface Done {
  receipt: Receipt;
  balance: string;
}

export function AddMoneySheet({ adapter, offline = false, embed, agentName, showDetails = false, onClose, onAdded }: Props) {
  const [agents, setAgents] = useState<AgentPublic[] | null>(null);
  const [chainMode, setChainMode] = useState<SummaryResponse["chainMode"] | null>(null);
  // The owner's checking (§16.4), when a bank is linked; null otherwise (the sheet reads as before).
  const [bank, setBank] = useState<SummaryResponse["bank"] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [picked, setPicked] = useState<string | undefined>(agentName);
  const [choice, setChoice] = useState("20.00");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Done | null>(null);
  const now = useNow(5000);

  const load = useCallback(async (a: WalletAdapter) => {
    try {
      const s = await a.getSummary();
      setAgents(s.agents);
      setChainMode(s.chainMode);
      setBank(s.bank ?? null);
      setLoadError(undefined);
      return s;
    } catch (err) {
      setLoadError(`Could not load your agents: ${(err as Error).message}`);
      return null;
    }
  }, []);

  useEffect(() => {
    if (adapter) void load(adapter);
  }, [adapter, load]);
  useEffect(() => setPicked(agentName), [agentName]);

  const agent = agents?.find((a) => a.name === picked);
  const chain = chainMode === "base-sepolia";
  const amount: AmountCheck = choice === CUSTOM ? parseAmount(custom) : { ok: true, amount: choice, cents: toCents(choice) };
  const linked = !!bank?.linked;

  const add = async () => {
    if (!adapter || !agent) return;
    if (!amount.ok) {
      setError(amount.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await adapter.topup(agent.id, amount.amount);
      const s = await load(adapter);
      const balance = s?.agents.find((a) => a.id === agent.id)?.balance ?? addDollars(agent.balance, receipt.amount);
      setDone({ receipt, balance });
      onAdded?.(agent.name, receipt.amount);
    } catch (err) {
      const e = err as Error;
      const bankSaid = e instanceof HttpError ? topupBankError(e.code, e.message, { checking: bank?.checkingBalance, amount: amount.amount }) : null;
      if (bankSaid) {
        // Nothing was credited (§16.3). Refresh checking so the source line shows what's really there.
        setError(bankSaid);
        void load(adapter);
      } else if (e instanceof HttpError && e.status === 501) {
        setChainMode("base-sepolia");
        setError("Top-ups aren't available on Base Sepolia.");
      } else if (e instanceof HttpError && e.status === 404) {
        setError(`${agent.name} is no longer in the wallet.`);
        void load(adapter);
      } else setError(e instanceof HttpError && e.status === 503 ? "The mock ledger is not reachable. Is the facilitator running?" : e.message);
    } finally {
      setBusy(false);
    }
  };

  const head = (
    <div className="osheet-title">
      {agent && <AgentAvatar name={agent.name} size="sm" badge={agent.frozen ? <Snowflake width={10} height={10} /> : undefined} />}
      <div className="osheet-titles">
        <h2 className="osheet-name">{agent ? `Add money to ${agent.name}` : "Add money"}</h2>
        <p className="osheet-sub">{agent ? `Balance ${money(done ? done.balance : agent.balance)}` : "Pick one of your agents"}</p>
      </div>
    </div>
  );

  // ---- done ----
  if (done && agent) {
    const r = done.receipt;
    const mark = bankMarker(r, linked);
    return (
      <SheetShell
        embed={embed}
        label={`Added money to ${agent.name}`}
        head={head}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDone(null)}>
              Add more
            </button>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <div className="done-line" role="status">
          <span className="done-check" aria-hidden>
            <Check width={14} height={14} />
          </span>
          <div>
            <h3 className="done-title">{r.bank || linked ? movedLine(r.amount, agent.name) : `Added ${money(r.amount)} to ${agent.name}`}</h3>
            {linked && bank?.checkingBalance !== undefined && (
              <p className="osheet-sub">
                Checking {masked(bank.checkingLast4)} now {money(bank.checkingBalance)}
              </p>
            )}
          </div>
        </div>
        <ul className="ln-list ln-group" aria-label="Receipt">
          <LineRow
            lead={null}
            className="ln-row-nolead"
            line={{ verb: r.description || "Top-up", tail: ` · ${r.counterparty?.name ?? "Mock USDC faucet"}` }}
            time={shortAgo(r.settledAt ?? r.createdAt, now)}
            amount={receiptAmount(r)}
          >
            {mark?.tone !== "failed" && <BankLine note={mark ? bankNote(r, bank?.checkingLast4) : null} />}
            <BankProblem marker={mark} />
            {(showDetails || r.txHash) && (
              <p className="ln-details">
                <code title={r.id}>{r.id}</code>
                {r.txHash &&
                  (r.explorerUrl && !embed ? (
                    <a href={r.explorerUrl} target="_blank" rel="noopener noreferrer" title={r.txHash}>
                      tx {shortHex(r.txHash)} <ArrowOut width={12} height={12} />
                    </a>
                  ) : (
                    <code title={r.txHash}>tx {shortHex(r.txHash)}</code>
                  ))}
              </p>
            )}
          </LineRow>
        </ul>
      </SheetShell>
    );
  }

  // ---- form ----
  const footer =
    agent && !chain ? (
      <>
        {error && (
          <p className="field-error osheet-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={busy || !adapter}>
          {busy ? (linked ? "Moving…" : "Adding…") : linked ? (amount.ok ? `Move ${shortMoney(amount.amount)} from Checking` : "Move from Checking") : amount.ok ? `Add ${shortMoney(amount.amount)} test money` : "Add test money"}
        </button>
      </>
    ) : undefined;

  return (
    <SheetShell embed={embed} label={agent ? `Add money to ${agent.name}` : "Add money"} head={head} footer={footer} locked={busy} onClose={onClose}>
      {offline && !adapter && <div className="osheet-banner banner-offline">Can't reach the wallet. Start it with npm run dev. Retrying…</div>}
      {loadError && <div className="osheet-banner banner-offline">{loadError}</div>}
      {adapter && !agents && !loadError && <p className="muted">Loading…</p>}

      {agents && !agent && (
        <Field label={picked ? `No agent named ${picked}. Pick one:` : "Which agent?"}>
          <ul className="ln-group">
            {agents.map((a) => (
              <li key={a.id}>
                <button type="button" className="grow grow-btn" onClick={() => setPicked(a.name)}>
                  <AgentAvatar name={a.name} size="xs" />
                  <span className="grow-main">
                    <span className="grow-title">{a.name}</span>
                  </span>
                  <span className="grow-end grow-amt">{money(a.balance)}</span>
                </button>
              </li>
            ))}
            {agents.length === 0 && <li className="grow muted">No agents yet.</li>}
          </ul>
        </Field>
      )}

      {agent && chain && (
        <>
          <p className="muted">Top-ups aren't available on Base Sepolia. Fund {agent.name}'s address with test USDC instead (a Base Sepolia faucet works).</p>
          <details className="osheet-details">
            <summary>Address to fund</summary>
            <CopyField value={agent.address} label={`${agent.name} address`} />
          </details>
        </>
      )}

      {agent && !chain && linked && bank && (
        <Field label="From">
          <ul className="ln-group">
            <li className="grow" title={SANDBOX_NOTE}>
              <BankTile size="xs" />
              <span className="grow-main">
                <span className="grow-title">Capital One Checking {masked(bank.checkingLast4)}</span>
              </span>
              {bank.checkingBalance !== undefined && (
                <span className="grow-meta">
                  <span className="grow-amt">{money(bank.checkingBalance)}</span> available
                </span>
              )}
            </li>
          </ul>
        </Field>
      )}

      {agent && !chain && (
        <Field
          label="Amount"
          aside="Up to $1,000"
          hint={linked ? "Sandbox money: Capital One moves it from Checking, then the same amount is added as test USDC." : "Test USDC on the mock ledger. Nothing real is charged."}
        >
          <AmountPicker
            id="am-amount"
            label="Amount"
            choice={choice}
            custom={custom}
            error={choice === CUSTOM && custom && !amount.ok ? amount.message : undefined}
            onChoice={(c) => {
              setChoice(c);
              setError(undefined);
            }}
            onCustom={(v) => {
              setCustom(v);
              setError(undefined);
            }}
          />
          {amount.ok && short(bank, amount.amount) && (
            <p className="bank-short" role="status">
              That's more than Checking has ({money(bank!.checkingBalance)}).
            </p>
          )}
          {agent.frozen && <p className="muted">{agent.name} is frozen. Money you add stays put until you unfreeze it.</p>}
          {showDetails && <code className="muted">{shortHex(agent.address, 8, 6)}</code>}
        </Field>
      )}
    </SheetShell>
  );
}
