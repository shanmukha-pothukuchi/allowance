/**
 * Schedules (§20.3, §20.4): every reminder, price watch and owner rule, one Linear row each, with
 * the autonomy switch in the header. Active rows first, grouped like Linear's issue groups; a row
 * says what it is (the rule, or the agent's own words), whose it is, when or on what it fires, how
 * often it has, and Cancel. Done ones sit below, muted.
 */
import { useState } from "react";
import { ruleWatches, scheduleNext, scheduleTitle, scheduleTrigger, sortSchedules, type Schedule, type SchedulerState } from "../invest";
import { shortAgo } from "../lines";
import type { Loadable } from "../useInvest";
import { AgentAvatar } from "./Avatar";
import { Warn } from "./Icons";
import { Switch } from "./Switch";

interface Props {
  scheduler: Loadable<SchedulerState>;
  busy: string[];
  now: number;
  onCancel(id: string): Promise<void>;
  onPause(paused: boolean): Promise<void>;
  onRetry(): void;
}

/** A rule says what it watches (its title has the threshold); anything else says its trigger. */
function trigger(s: Schedule, now: number): string {
  return s.rule ? ruleWatches(s) : scheduleTrigger(s, now);
}

const ENDED: Record<string, string> = { cancelled: "Cancelled", expired: "Expired", replaced: "Replaced", missed: "Missed" };

/** How a done row ended, in a word or two: "Fired 9m ago", "Cancelled", "Replaced". */
function endedText(s: Schedule, now: number): string {
  if (s.endedReason && ENDED[s.endedReason]) return ENDED[s.endedReason];
  if (s.fired > 0 && s.lastFiredAt) return `Fired ${shortAgo(s.lastFiredAt, now)}`;
  return s.endedReason === "fired" ? "Fired" : "Ended";
}

function ScheduleRow({ s, now, busy, onCancel }: { s: Schedule; now: number; busy: boolean; onCancel(): void }) {
  const next = scheduleNext(s, now);
  const done = !s.active;
  const ended = endedText(s, now);
  return (
    <li className={`sc-row${done ? " sc-done" : ""}`}>
      <AgentAvatar name={s.agentName} size="xs" />
      <span className="sc-main">
        <span className="sc-title" title={s.message}>
          {scheduleTitle(s)}
        </span>
        <span className="sc-meta">
          {s.agentName} · {s.source === "owner" ? "your rule" : "set by the agent"}
        </span>
      </span>
      <span className="sc-when" title={s.lastObserved ? `Last check: ${s.lastObserved}` : undefined}>
        {trigger(s, now)}
        {!done && next && !s.needsChat && <span className="sc-next"> · {next}</span>}
        {done && <span className="sc-next"> · {ended}</span>}
      </span>
      <span className="sc-marks">{s.needsChat && !done && <span className="ln-chip" title="Claude Desktop has no chat server to wake, so this can't fire">Needs the chat</span>}</span>
      {/* A done row already says when it fired; the count only adds something past one. */}
      <span className="sc-fired" title={s.fired ? `Fired ${s.fired} ${s.fired === 1 ? "time" : "times"}` : undefined}>
        {s.fired > (done ? 1 : 0) ? `${s.fired} fired` : ""}
      </span>
      <span className="sc-act">
        {!done && (
          <button type="button" className="btn btn-sm btn-quiet" onClick={onCancel} disabled={busy} aria-label={`Cancel ${scheduleTitle(s)} for ${s.agentName}`}>
            {busy ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </span>
    </li>
  );
}

export function SchedulesView({ scheduler, busy, now, onCancel, onPause, onRetry }: Props) {
  const [error, setError] = useState<string>();
  const data = scheduler.state === "ready" ? scheduler.data : scheduler.state === "error" ? scheduler.data : undefined;
  const all = sortSchedules(data?.schedules ?? []);
  const active = all.filter((s) => s.active);
  const done = all.filter((s) => !s.active).slice(0, 12);
  const paused = !!data?.paused;
  const run = async (fn: () => Promise<void>) => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="services-view sc-view">
      <header className="services-head">
        <div className="services-title">
          <h1>
            Schedules {paused && <span className="ln-chip sc-paused">Paused</span>}
          </h1>
          <p className="muted">{paused ? "Nothing fires until you turn autonomy back on" : `Reminders, price watches and your rules wake agents on their own · ${active.length} active`}</p>
        </div>
        <div className="services-actions">
          <label className="sc-switch">
            <span>Autonomy</span>
            <Switch on={!!data && !paused} label={paused ? "Resume all schedules" : "Pause all schedules"} busy={busy.includes("pause")} disabled={!data} onChange={(on) => void run(() => onPause(!on))} />
          </label>
        </div>
      </header>

      <div className="services-scroll">
        {scheduler.state === "error" && (
          <div className="directory-error" role="alert">
            <Warn width={15} height={15} />
            <span>{scheduler.message}</span>
            <button className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {error && (
          <div className="directory-error" role="alert">
            <Warn width={15} height={15} />
            <span>{error}</span>
          </div>
        )}
        {scheduler.state === "loading" && <p className="empty">Loading the scheduler…</p>}
        {data && all.length === 0 && <p className="empty">No schedules yet.</p>}
        {active.length > 0 && (
          <section className="svc-group" aria-label="Active">
            <h2 className="svc-group-head">
              Active <span className="muted">{active.length}</span>
            </h2>
            <ul className="svc-list">
              {active.map((s) => (
                <ScheduleRow key={s.id} s={s} now={now} busy={busy.includes(s.id)} onCancel={() => void run(() => onCancel(s.id))} />
              ))}
            </ul>
          </section>
        )}
        {done.length > 0 && (
          <section className="svc-group" aria-label="Done">
            <h2 className="svc-group-head">
              Done <span className="muted">{done.length}</span>
            </h2>
            <ul className="svc-list">
              {done.map((s) => (
                <ScheduleRow key={s.id} s={s} now={now} busy={false} onCancel={() => undefined} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
