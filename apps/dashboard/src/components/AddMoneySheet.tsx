/** "Add money" (§14.3): test money for one agent on the mock ledger. `POST /v1/agents/:id/topup`. */
import { useCallback, useEffect, useState } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { addDollars, money, relativeTime, shortHex, toCents } from "../format";
import { parseAmount, shortMoney, type AmountCheck } from "../sheets";
import type { AgentPublic, Receipt, SummaryResponse } from "../types";
import { useNow } from "../useWallet";
import { AgentAvatar } from "./Avatar";
import { ArrowOut, Check, Info, Plus, Snowflake } from "./Icons";
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
      if (e instanceof HttpError && e.status === 501) {
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

  const head = agent ? (
    <div className="osheet-title">
      <AgentAvatar name={agent.name} size="xl" badge={agent.frozen ? <Snowflake width={14} height={14} /> : undefined} />
      <div className="osheet-titles">
        <h2 className="osheet-name">{agent.name}</h2>
        <p className="muted">
          Balance <strong className="osheet-balance">{money(done ? done.balance : agent.balance)}</strong>
        </p>
      </div>
    </div>
  ) : (
    <div className="osheet-title">
      <span className="avatar avatar-xl avatar-empty" aria-hidden>
        <Plus width={30} height={30} />
      </span>
      <div className="osheet-titles">
        <h2 className="osheet-name">Add money</h2>
        <p className="muted">Test money for one of your agents</p>
      </div>
    </div>
  );

  // ---- done ----
  if (done && agent) {
    const r = done.receipt;
    return (
      <SheetShell
        embed={embed}
        label={`Added money to ${agent.name}`}
        head={head}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-big" onClick={() => setDone(null)}>
              <Plus width={18} height={18} /> Add more
            </button>
            <button type="button" className="btn btn-primary btn-big" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <div className="created" role="status">
          <span className="done-check" aria-hidden>
            <Check width={34} height={34} />
          </span>
          <h3 className="created-title">
            Added {money(r.amount)} to {agent.name}
          </h3>
          <p className="created-balance">
            <span className="muted">New balance</span>
            <span className="created-amount">{money(done.balance)}</span>
          </p>
        </div>
        <div className="receipt-card" aria-label="Receipt">
          <div className="receipt-row">
            <span>{r.description || "Top-up"}</span>
            <strong className="earned">+{money(r.amount)}</strong>
          </div>
          <div className="receipt-row muted">
            <span>{r.counterparty?.name ?? "Mock USDC faucet"}</span>
            <span>
              {r.status === "settled" ? "done" : r.status} · {relativeTime(r.settledAt ?? r.createdAt, now)}
            </span>
          </div>
          <div className="receipt-row receipt-ids muted">
            <code title={r.id}>{r.id}</code>
            {r.txHash &&
              (r.explorerUrl && !embed ? (
                <a href={r.explorerUrl} target="_blank" rel="noopener noreferrer" title={r.txHash}>
                  tx {shortHex(r.txHash)} <ArrowOut width={14} height={14} />
                </a>
              ) : (
                <code title={r.txHash}>tx {shortHex(r.txHash)}</code>
              ))}
          </div>
        </div>
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
        <button type="button" className="btn btn-big" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-big" onClick={() => void add()} disabled={busy || !adapter}>
          {busy ? "Adding…" : amount.ok ? `Add ${shortMoney(amount.amount)} test money` : "Add test money"}
        </button>
      </>
    ) : (
      <button type="button" className="btn btn-big" onClick={onClose}>
        Close
      </button>
    );

  return (
    <SheetShell embed={embed} label={agent ? `Add money to ${agent.name}` : "Add money"} head={head} footer={footer} locked={busy} onClose={onClose}>
      {offline && !adapter && <div className="osheet-banner banner-offline">Can't reach the wallet. Start it with npm run dev. Retrying…</div>}
      {loadError && <div className="osheet-banner banner-offline">{loadError}</div>}
      {adapter && !agents && !loadError && <p className="muted">Loading…</p>}

      {agents && !agent && (
        <Field label="Which agent?">
          {picked && <p className="osheet-info">No agent named {picked}. Pick one of yours:</p>}
          <ul className="agent-picks">
            {agents.map((a) => (
              <li key={a.id}>
                <button type="button" className="agent-pick" onClick={() => setPicked(a.name)}>
                  <AgentAvatar name={a.name} size="sm" />
                  <span className="agent-pick-name">{a.name}</span>
                  <span className="muted">{money(a.balance)}</span>
                </button>
              </li>
            ))}
            {agents.length === 0 && <li className="muted">No agents yet.</li>}
          </ul>
        </Field>
      )}

      {agent && chain && (
        <>
          <p className="osheet-info">
            <Info width={20} height={20} />
            <span>Top-ups aren't available on Base Sepolia. Fund {agent.name}'s address with test USDC instead (a Base Sepolia faucet works).</span>
          </p>
          <details className="osheet-details">
            <summary>Address to fund</summary>
            <CopyField value={agent.address} label={`${agent.name} address`} />
          </details>
        </>
      )}

      {agent && !chain && (
        <Field label="Amount" aside={<span className="test-badge">Test money</span>} hint="Test USDC minted on the mock ledger, up to $1,000 at a time. Nothing real is charged.">
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
          {agent.frozen && <p className="muted frozen-note">{agent.name} is frozen. Money you add stays put until you unfreeze it.</p>}
          {showDetails && <code className="muted">{shortHex(agent.address, 8, 6)}</code>}
        </Field>
      )}
    </SheetShell>
  );
}
