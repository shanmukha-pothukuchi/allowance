import { useMemo } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { AgentCard } from "./components/AgentCard";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { ReceiptsList } from "./components/ReceiptsList";
import { TopBar } from "./components/TopBar";
import { useNow, useWallet } from "./useWallet";

export default function App() {
  const { state, actions } = useWallet();
  const now = useNow(1000);
  const pendingIds = useMemo(() => new Set(state.approvals.map((a) => a.id)), [state.approvals]);
  // Frozen agents float to the top so the moment the wallet holds is never below the fold.
  const agents = useMemo(() => [...state.agents.filter((a) => a.frozen), ...state.agents.filter((a) => !a.frozen)], [state.agents]);

  return (
    <div className="app">
      <TopBar state={state} onToggleDetails={actions.toggleDetails} />
      <main className="columns">
        <section className="panel agents">
          <h2 className="panel-title">
            Agents <span className="muted">{state.agents.length}</span>
          </h2>
          <div className="agent-list">
            {state.agents.length === 0 && <p className="empty">{state.loaded ? "No agents yet. Run npm run setup." : "Loading…"}</p>}
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                showDetails={state.showDetails}
                busy={state.busyAgents.includes(a.id)}
                onFreeze={() => void actions.freeze(a.id)}
                onUnfreeze={() => void actions.unfreeze(a.id)}
                onTopup={() => void actions.topup(a.id, "20.00")}
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
    </div>
  );
}
