import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { AddMoneySheet } from "./components/AddMoneySheet";
import { AgentCard } from "./components/AgentCard";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { Plus } from "./components/Icons";
import { NewAgentSheet } from "./components/NewAgentSheet";
import { ReceiptsList } from "./components/ReceiptsList";
import { ServicesView } from "./components/ServicesView";
import { TopBar } from "./components/TopBar";
import { useRoute, useSheetRoute } from "./route";
import { chatUrlFrom } from "./sheets";
import { applyTheme, effectiveTheme, saveTheme, storedTheme, themeFromSearch, type ThemePref } from "./theme";
import { useNow, useWallet } from "./useWallet";

function useTheme(): ["dark" | "light", () => void] {
  const [pref, setPref] = useState<ThemePref>(() => themeFromSearch(location.search) ?? storedTheme() ?? "system");
  const [, bump] = useState(0);
  useEffect(() => applyTheme(pref), [pref]);
  useEffect(() => {
    // Follow the OS while no explicit choice is made.
    const mq = matchMedia("(prefers-color-scheme: light)");
    const on = () => bump((n) => n + 1);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
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

  return (
    <div className="app">
      <TopBar state={state} route={route} theme={theme} onToggleTheme={toggleTheme} onToggleDetails={actions.toggleDetails} />
      {route.view === "services" ? (
        <ServicesView state={state} actions={actions} selectedId={route.serviceId} now={now} />
      ) : (
        <main className="columns">
          <section className="panel agents">
            <h2 className="panel-title">
              Agents <span className="muted">{state.agents.length}</span>
              <button className="btn btn-new-agent" onClick={() => setSheet({ sheet: "new-agent" })} title="Create an agent and give it money">
                <Plus width={18} height={18} /> New agent
              </button>
            </h2>
            <div className="agent-list">
              {state.agents.length === 0 && <p className="empty">{state.loaded ? "No agents yet. Create one with New agent, or run npm run setup." : "Loading…"}</p>}
              {agents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  showDetails={state.showDetails}
                  busy={state.busyAgents.includes(a.id)}
                  onFreeze={() => void actions.freeze(a.id)}
                  onUnfreeze={() => void actions.unfreeze(a.id)}
                  onAddMoney={() => setSheet({ sheet: "add-money", agent: a.name })}
                />
              ))}
            </div>
          </section>

          <ActivityFeed
            events={state.events}
            pendingIds={pendingIds}
            busyApprovals={state.busyApprovals}
            showDetails={state.showDetails}
            now={now}
            onApprove={(id) => void actions.approve(id)}
            onDeny={(id) => void actions.deny(id)}
          />

          <aside className="side">
            <ApprovalsPanel
              approvals={state.approvals}
              busy={state.busyApprovals}
              showDetails={state.showDetails}
              now={now}
              onApprove={(id) => void actions.approve(id)}
              onDeny={(id) => void actions.deny(id)}
            />
            <ReceiptsList receipts={state.receipts} showDetails={state.showDetails} now={now} />
          </aside>
        </main>
      )}

      {sheet?.sheet === "new-agent" && (
        <NewAgentSheet adapter={adapter} offline={state.connection === "offline"} embed={false} chatUrl={chatUrl} knownNames={agentNames} onClose={closeSheet} onCreated={actions.refresh} />
      )}
      {sheet?.sheet === "add-money" && (
        <AddMoneySheet adapter={adapter} offline={state.connection === "offline"} embed={false} agentName={sheet.agent} showDetails={state.showDetails} onClose={closeSheet} onAdded={actions.refresh} />
      )}
    </div>
  );
}
