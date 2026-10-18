import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SchedulerState } from "./types.js";

/** Ended schedules kept for the owner's history. */
const KEEP_ENDED = 200;

export function emptyState(): SchedulerState {
  return { version: 1, paused: false, schedules: [], firings: {} };
}

/** `DATA_DIR/schedules.json`, written atomically. Omit the file to keep everything in memory (tests). */
export class ScheduleStore {
  state: SchedulerState;
  constructor(readonly file?: string) {
    this.state = this.load();
  }

  private load(): SchedulerState {
    if (!this.file || !existsSync(this.file)) return emptyState();
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SchedulerState>;
      return {
        version: 1,
        paused: j.paused === true,
        ...(j.pausedAt ? { pausedAt: j.pausedAt } : {}),
        schedules: Array.isArray(j.schedules) ? j.schedules : [],
        firings: j.firings && typeof j.firings === "object" ? j.firings : {},
      };
    } catch (err) {
      console.warn(`[scheduler] ${this.file} is unreadable (${(err as Error).message}); starting empty`);
      return emptyState();
    }
  }

  save(): void {
    const ended = this.state.schedules.filter((s) => !s.active);
    if (ended.length > KEEP_ENDED) {
      const drop = new Set(ended.sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? "")).slice(0, ended.length - KEEP_ENDED).map((s) => s.id));
      this.state.schedules = this.state.schedules.filter((s) => !drop.has(s.id));
    }
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
