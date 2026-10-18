/**
 * One agent in detail (§16.5, `/?sheet=agent&agent=<name>`, dashboard only): its Capital One
 * allowance account and balance, the latest entries on that account's statement as Nessie reports
 * them (`GET /v1/bank/statement?agentId=`), and its recent receipts with their statement markers.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { masked, SANDBOX_NOTE } from "../bank";
import { isShopifyGrant, money, toCents } from "../format";
import { navigate } from "../route";
import { limitsLine } from "../sheets";
import { capLabel } from "../shopify";
import type { AgentPublic, BankAccountView, BankStatementEntry, Receipt } from "../types";
import { AgentAvatar, roleLabel, ServiceTile } from "./Avatar";
import { StatementList } from "./BankParts";
import { Chevron, Plus, Snowflake } from "./Icons";
import { ReceiptRow } from "./ReceiptsList";
import { Facts, Field, SheetShell } from "./SheetParts";

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
  /** The owner's checking (top-ups come from it). */
  checkingLast4?: string;
  onRetry?(receiptId: string): void;
  onAddMoney(): void;
  onClose(): void;
}

type Statement = { state: "loading" } | { state: "ready"; entries: BankStatementEntry[] } | { state: "error"; message: string };

export function AgentSheet({ adapter, agent, agentName, account, bankLinked, receipts, now, refreshKey, retrying = [], checkingLast4, onRetry, onAddMoney, onClose }: Props) {
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
  const services = (agent?.services ?? []).filter((x) => x.id !== "directory");
  const role = agent && roleLabel(agent.name).toLowerCase().replace(/\s+/g, "-") !== agent.name.toLowerCase() ? roleLabel(agent.name) : "";

  const head = (
    <div className="osheet-title">
      {agent && <AgentAvatar name={agent.name} size="sm" badge={agent.frozen ? <Snowflake width={10} height={10} /> : undefined} />}
      <div className="osheet-titles">
        <h2 className="osheet-name">{agent?.name ?? agentName}</h2>
        <p className={`osheet-sub${agent?.frozen ? " osheet-sub-danger" : ""}`}>{!agent ? "Not in the wallet" : agent.frozen ? "Frozen by your wallet" : role || "Agent"}</p>
      </div>
    </div>
  );

  const footer = agent && (
    <button type="button" className="btn btn-primary" onClick={onAddMoney}>
      <Plus width={14} height={14} /> Add money
    </button>
  );

  // The balance once; the bank's figure only when it says something different.
  const bankDiffers = !!account && account.balance !== undefined && toCents(account.balance) !== toCents(agent?.balance);

  return (
    <SheetShell embed={false} label={`${agentName} details`} head={head} footer={footer} onClose={onClose}>
      {!agent && <p className="muted">No agent named {agentName}.</p>}

      {agent && (
        <Facts
          rows={[
            ["Balance", <span className="facts-num">{money(agent.balance)} <span className="muted">in USDC</span></span>],
            ["Spent today", <span className="facts-num">{money(agent.spentToday)} <span className="muted">of {money(agent.policy.dailyCap)}</span></span>],
            ["Limits", limitsLine({ maxPerTx: agent.policy.maxPerTx, dailyCap: agent.policy.dailyCap, approvalThreshold: agent.policy.approvalThreshold })],
            ...(agent.frozenReason && agent.frozen ? ([["Why frozen", agent.frozenReason]] as [string, ReactNode][]) : []),
          ]}
        />
      )}

      {agent && bankLinked && account && (
        <Field label="Capital One statement" aside={<span title={SANDBOX_NOTE}>{masked(account.last4)} · Nessie sandbox{bankDiffers ? ` · balance ${money(account.balance)}` : ""}</span>}>
          {stmt.state === "loading" && <p className="muted">Loading the statement…</p>}
          {stmt.state === "error" && <p className="muted">{stmt.message}</p>}
          {stmt.state === "ready" && (stmt.entries.length === 0 ? <p className="muted">Nothing on the statement yet.</p> : <StatementList entries={stmt.entries} now={now} />)}
        </Field>
      )}

      {agent && bankLinked && !account && <p className="muted">No Capital One account yet. The bank opens one the first time {agent.name}'s money moves.</p>}

      {agent && services.length > 0 && (
        <Field label="Services" aside={services.length}>
          <ul className="ln-group">
            {services.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  className="grow grow-btn"
                  onClick={() => {
                    onClose();
                    navigate({ view: "services", serviceId: x.id });
                  }}
                >
                  <ServiceTile name={x.name} color={x.color} size="xs" shopify={isShopifyGrant(x)} />
                  <span className="grow-main">
                    <span className="grow-title">{x.name}</span>
                  </span>
                  <span className="grow-meta">{isShopifyGrant(x) ? capLabel(x.maxPrice) : x.pricing}</span>
                  <Chevron width={14} height={14} className="grow-chev" />
                </button>
              </li>
            ))}
          </ul>
        </Field>
      )}

      {agent && (
        <Field label="Recent receipts">
          {mine.length === 0 ? (
            <p className="muted">No receipts yet.</p>
          ) : (
            <ul className="ln-list ln-group">
              {mine.map((r) => (
                <ReceiptRow
                  key={r.id}
                  r={r}
                  now={now}
                  bankLinked={bankLinked}
                  hideAgent
                  bankText
                  checkingLast4={checkingLast4}
                  onRetry={onRetry && (() => onRetry(r.id))}
                  busy={retrying.includes(r.id) || retrying.includes("*")}
                />
              ))}
            </ul>
          )}
        </Field>
      )}
    </SheetShell>
  );
}
