/**
 * One agent in detail (§16.5, `/?sheet=agent&agent=<name>`, dashboard only): its Capital One
 * allowance account and balance, the latest entries on that account's statement as Nessie reports
 * them (`GET /v1/bank/statement?agentId=`), and its recent receipts with their statement markers.
 */
import { useEffect, useRef, useState } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { bankMarker, masked } from "../bank";
import { counterpartyName, money, relativeTime, signedMoney } from "../format";
import type { AgentPublic, BankAccountView, BankStatementEntry, Receipt } from "../types";
import { AgentAvatar, roleLabel } from "./Avatar";
import { BankMarkerView, BankTile, StatementList } from "./BankParts";
import { Plus, Snowflake } from "./Icons";
import { Field, SheetShell } from "./SheetParts";

interface Props {
  adapter: WalletAdapter | null;
  agent: AgentPublic | undefined;
  /** The name from the URL, for the "not found" state. */
  agentName: string;
  /** Its allowance account from `GET /v1/bank`, if the bank opened one. */
  account?: BankAccountView;
  bankLinked: boolean;
  receipts: Receipt[];
  now: number;
  /** Changes whenever the bank summary is refetched (after money or bank events): reload the statement. */
  refreshKey?: string;
  /** Receipt ids with a retry in flight ("*": all of them). */
  retrying?: string[];
  onRetry?(receiptId: string): void;
  onAddMoney(): void;
  onClose(): void;
}

type Statement = { state: "loading" } | { state: "ready"; entries: BankStatementEntry[] } | { state: "error"; message: string };

const amountText = (r: Receipt) => (r.kind === "earn" || r.kind === "topup" ? signedMoney(r.amount, "+") : signedMoney(r.amount, "-"));

export function AgentSheet({ adapter, agent, agentName, account, bankLinked, receipts, now, refreshKey, retrying = [], onRetry, onAddMoney, onClose }: Props) {
  const [stmt, setStmt] = useState<Statement>({ state: "loading" });
  const seq = useRef(0);
  const agentId = agent?.id;
  const hasAccount = !!account;

  useEffect(() => {
    if (!adapter || !agentId || !bankLinked || !hasAccount) return;
    const mine = ++seq.current;
    adapter
      .getBankStatement(agentId, 20)
      .then((r) => mine === seq.current && setStmt({ state: "ready", entries: r.entries }))
      .catch((err: Error) => {
        if (mine !== seq.current) return;
        // §16.4: bank_account_not_found and friends come with an owner-readable message.
        const message =
          err instanceof HttpError && err.code === "bank_unavailable"
            ? "Capital One didn't answer, so the statement isn't here right now. It'll load again as money moves."
            : err instanceof HttpError && err.code
              ? err.message
              : `Couldn't load the statement: ${err.message}`;
        setStmt((s) => (s.state === "ready" ? s : { state: "error", message }));
      });
  }, [adapter, agentId, bankLinked, hasAccount, refreshKey]);

  const mine = agent ? receipts.filter((r) => r.agentId === agent.id).slice(0, 6) : [];

  const head = agent ? (
    <div className="osheet-title">
      <AgentAvatar name={agent.name} size="xl" badge={agent.frozen ? <Snowflake width={14} height={14} /> : undefined} />
      <div className="osheet-titles">
        <h2 className="osheet-name">{agent.name}</h2>
        <p className="muted">
          {roleLabel(agent.name)} · Balance <strong className="osheet-balance">{money(agent.balance)}</strong>
        </p>
      </div>
    </div>
  ) : (
    <div className="osheet-title">
      <div className="osheet-titles">
        <h2 className="osheet-name">{agentName}</h2>
        <p className="muted">Not in the wallet</p>
      </div>
    </div>
  );

  const footer = (
    <>
      {agent && (
        <button type="button" className="btn btn-big" onClick={onAddMoney}>
          <Plus width={18} height={18} /> Add money
        </button>
      )}
      <button type="button" className="btn btn-primary btn-big" onClick={onClose}>
        Done
      </button>
    </>
  );

  return (
    <SheetShell embed={false} label={`${agentName} details`} head={head} footer={footer} onClose={onClose}>
      {!agent && <p className="muted">No agent named {agentName}.</p>}

      {agent && bankLinked && account && (
        <>
          <section className="bank-card" aria-label="Capital One allowance account">
            <div className="bank-card-row">
              <BankTile />
              <span className="bank-card-main">
                <span className="bank-card-name">Capital One allowance account {masked(account.last4)}</span>
                <span className="muted bank-card-nick">{account.nickname}</span>
              </span>
              <span className="bank-card-amt">{money(account.balance)}</span>
            </div>
          </section>
          <Field label="Statement" aside={<span className="sandbox-tag">Nessie sandbox</span>} hint="As Capital One's Nessie sandbox reports it. Each payment shows under the merchant's name; the status is Nessie's.">
            {stmt.state === "loading" && <p className="muted">Loading the statement…</p>}
            {stmt.state === "error" && <p className="muted">{stmt.message}</p>}
            {stmt.state === "ready" && (stmt.entries.length === 0 ? <p className="muted">Nothing on the statement yet.</p> : <StatementList entries={stmt.entries} now={now} />)}
          </Field>
        </>
      )}

      {agent && bankLinked && !account && <p className="muted">No Capital One account yet. The bank opens one the first time {agent.name}'s money moves.</p>}

      {agent && (
        <Field label="Recent receipts">
          {mine.length === 0 ? (
            <p className="muted">No receipts yet.</p>
          ) : (
            <ul className="bank-activity">
              {mine.map((r) => (
                <li key={r.id} className="bank-act-row">
                  <span className="bank-act-main">
                    <span className="bank-act-what">{r.description || counterpartyName(r)}</span>
                    <span className="bank-act-sub">
                      <span className="muted">{relativeTime(r.createdAt, now)}</span>
                      <BankMarkerView marker={bankMarker(r, bankLinked)} onRetry={onRetry && (() => onRetry(r.id))} busy={retrying.includes(r.id) || retrying.includes("*")} />
                    </span>
                  </span>
                  <span className={`bank-act-amt${r.kind === "earn" || r.kind === "topup" ? " amt-in" : ""}${r.status === "blocked" || r.status === "denied" ? " amt-void" : ""}`}>
                    {r.status === "blocked" || r.status === "denied" ? money(r.amount) : amountText(r)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Field>
      )}
    </SheetShell>
  );
}
