import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { AddMoneySheet } from "./components/AddMoneySheet";
import { AddServiceSheet } from "./components/AddServiceSheet";
import { AgentCard } from "./components/AgentCard";
import { AgentSheet } from "./components/AgentSheet";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { BankSheet } from "./components/BankSheet";
import { Plus } from "./components/Icons";
import { NewAgentSheet } from "./components/NewAgentSheet";
import { ReceiptsList } from "./components/ReceiptsList";
import { ServicesView } from "./components/ServicesView";
import { Banners, SideNav } from "./components/TopBar";
import { accountFor, isLinked } from "./bank";
import { money, toCents } from "./format";
import { navigate, useRoute, useSheetRoute } from "./route";
import { chatUrlFrom } from "./sheets";
import { applyTheme, effectiveTheme, saveTheme, storedTheme, themeFromSearch, type ThemePref } from "./theme";
import { useNow, useWallet } from "./useWallet";

function useTheme(): ["dark" | "light", () => void] {
  const [pref, setPref] = useState<ThemePref>(() => themeFromSearch(location.search) ?? storedTheme() ?? "system");
  useEffect(() => applyTheme(pref), [pref]);
  const current = effectiveTheme(pref);
  const toggle = useCallback(() => {
    const next = current === "dark" ? "light" : "dark";
    saveTheme(next);
    setPref(next);
  }, [current]);
  return [current, toggle];
}

export default function App() {
  const { state, actions, adapter } = useWallet();
  const now = useNow(1000);
  const route = useRoute();
  const [sheet, setSheet] = useSheetRoute();
  const closeSheet = useCallback(() => setSheet(null), [setSheet]);
  const chatUrl = useMemo(() => chatUrlFrom(), []);
  const agentNames = useMemo(() => state.agents.map((a) => a.name), [state.agents]);
  const [theme, toggleTheme] = useTheme();
  const pendingIds = useMemo(() => new Set(state.approvals.map((a) => a.id)), [state.approvals]);
  // Frozen agents float to the top so the moment the wallet holds is never below the fold.
  const agents = useMemo(() => [...state.agents.filter((a) => a.frozen), ...state.agents.filter((a) => !a.frozen)], [state.agents]);
  // Capital One (§16): only with a linked bank do rows, receipts and the feed carry bank lines.
  const bankLinked = isLinked(state.totals.bank);
  // Receipt ids with a retry in flight; "*" while every failed one is being retried.
  const [retrying, setRetrying] = useState<string[]>([]);
  const retryBank = useCallback(
    async (receiptId?: string) => {
      const key = receiptId ?? "*";
      setRetrying((ids) => [...ids, key]);
      try {
        await actions.retryBank(receiptId);
      } finally {
        setRetrying((ids) => ids.filter((x) => x !== key));
      }
    },
    [actions],
  );
  const sheetAgent = sheet?.sheet === "agent" ? state.agents.find((a) => a.name === sheet.agent) : undefined;

  const [feedTab, setFeedTab] = useState<"activity" | "receipts">("activity");
  const pending = state.approvals.length;
  const ledger = state.totals.chainMode === "mock" ? "test money on the mock ledger" : state.totals.chainMode === "unknown" ? "" : "USDC on Base Sepolia";

  return (
    <div className="app">
      <SideNav state={state} route={route} theme={theme} onToggleTheme={toggleTheme} onToggleDetails={actions.toggleDetails} onOpenBank={() => setSheet({ sheet: "bank" })} />
      <div className="page">
        <Banners state={state} />
        {route.view === "services" ? (
          <ServicesView state={state} actions={actions} selectedId={route.serviceId} now={now} onAddService={() => setSheet({ sheet: "add-service" })} />
        ) : (
          <main className="overview">
            <header className="page-head">
              <div className="balance-block">
                <span className="eyebrow">Total balance</span>
                <span className="balance">{money(state.totals.totalBalance)}</span>
                <span className="balance-sub">
                  {state.agents.length} {state.agents.length === 1 ? "agent" : "agents"}
                  {ledger && ` · ${ledger}`}
                </span>
              </div>
              <dl className="kpis">
                <div>
                  <dt>Spent today</dt>
                  <dd>{money(state.totals.spentToday)}</dd>
                </div>
                <div>
                  <dt>Earned today</dt>
                  <dd className={toCents(state.totals.earnedToday) > 0 ? "amt-in" : ""}>
                    {toCents(state.totals.earnedToday) > 0 ? "+" : ""}
                    {money(state.totals.earnedToday)}
                  </dd>
                </div>
              </dl>
            </header>

            {pending > 0 && (
              <ApprovalsPanel
                approvals={state.approvals}
                busy={state.busyApprovals}
                showDetails={state.showDetails}
                now={now}
                onApprove={(id) => void actions.approve(id)}
                onDeny={(id) => void actions.deny(id)}
              />
            )}

            <div className="ov-grid">
              <section className="ov-sec" aria-label="Agents">
                <div className="section-head">
                  <h2 className="section-title">
                    Agents <span className="muted">{state.agents.length}</span>
                  </h2>
                  <button className="btn btn-sm" onClick={() => setSheet({ sheet: "new-agent" })}>
                    <Plus width={14} height={14} /> New agent
                  </button>
                </div>
                <ul className="agent-list">
                  {state.agents.length === 0 && <li className="empty">{state.loaded ? "No agents yet. Create one with New agent, or run npm run setup." : "Loading…"}</li>}
                  {agents.map((a) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      showDetails={state.showDetails}
                      busy={state.busyAgents.includes(a.id)}
                      onFreeze={() => void actions.freeze(a.id)}
                      onUnfreeze={() => void actions.unfreeze(a.id)}
                      onAddMoney={() => setSheet({ sheet: "add-money", agent: a.name })}
                      bankAccount={bankLinked ? accountFor(state.bank, a.id) : undefined}
                      onOpen={() => setSheet({ sheet: "agent", agent: a.name })}
                    />
                  ))}
                </ul>
              </section>

              <section className="ov-sec" aria-label="Activity">
                <div className="section-head">
                  <h2 className="section-title">
                    {feedTab === "activity" ? "Activity" : "Receipts"}
                    {state.connection === "live" && <span className="live-tag">Live</span>}
                  </h2>
                  <div className="seg" role="tablist" aria-label="Show">
                    <button role="tab" aria-selected={feedTab === "activity"} className={feedTab === "activity" ? "seg-on" : ""} onClick={() => setFeedTab("activity")}>
                      Activity
                    </button>
                    <button role="tab" aria-selected={feedTab === "receipts"} className={feedTab === "receipts" ? "seg-on" : ""} onClick={() => setFeedTab("receipts")}>
                      Receipts
                    </button>
                  </div>
                </div>
                {feedTab === "activity" ? (
                  <ActivityFeed
                    events={state.events}
                    pendingIds={pendingIds}
                    showDetails={state.showDetails}
                    now={now}
                    bankLinked={bankLinked}
                    onRetryBank={(id) => void retryBank(id)}
                    retrying={retrying}
                    checkingLast4={state.totals.bank?.checkingLast4}
                  />
                ) : (
                  <ReceiptsList
                    receipts={state.receipts}
                    showDetails={state.showDetails}
                    now={now}
                    bankLinked={bankLinked}
                    onRetryBank={(id) => void retryBank(id)}
                    retrying={retrying}
                    checkingLast4={state.totals.bank?.checkingLast4}
                  />
                )}
              </section>
            </div>
          </main>
        )}
      </div>

      {sheet?.sheet === "new-agent" && (
        <NewAgentSheet adapter={adapter} offline={state.connection === "offline"} embed={false} chatUrl={chatUrl} knownNames={agentNames} onClose={closeSheet} onCreated={actions.refresh} />
      )}
      {sheet?.sheet === "add-service" && (
        <AddServiceSheet
          adapter={adapter}
          offline={state.connection === "offline"}
          preselect={sheet.agent}
          agents={state.agents}
          directory={state.directory}
          onClose={closeSheet}
          onDone={(serviceId, listed) => {
            if (listed) actions.serviceAdded(listed);
            else actions.refresh();
            closeSheet();
            navigate({ view: "services", serviceId });
          }}
        />
      )}
      {sheet?.sheet === "add-money" && (
        <AddMoneySheet adapter={adapter} offline={state.connection === "offline"} embed={false} agentName={sheet.agent} showDetails={state.showDetails} onClose={closeSheet} onAdded={actions.refresh} />
      )}
      {sheet?.sheet === "bank" && (
        <BankSheet
          adapter={adapter}
          offline={state.connection === "offline"}
          embed={false}
          bank={state.bank}
          receipts={state.receipts}
          onClose={closeSheet}
          onOpenAgent={(name) => setSheet({ sheet: "agent", agent: name })}
          onRetry={retryBank}
          onChanged={actions.refresh}
        />
      )}
      {sheet?.sheet === "agent" && (
        <AgentSheet
          adapter={adapter}
          agent={sheetAgent}
          agentName={sheet.agent}
          account={sheetAgent && bankLinked ? accountFor(state.bank, sheetAgent.id) : undefined}
          bankLinked={bankLinked}
          receipts={state.receipts}
          now={now}
          refreshKey={state.bank?.updatedAt}
          retrying={retrying}
          checkingLast4={state.totals.bank?.checkingLast4}
          onRetry={(id) => void retryBank(id)}
          onAddMoney={() => setSheet({ sheet: "add-money", agent: sheet.agent })}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}
