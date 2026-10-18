/**
 * The brokerage's price clock (docs/ARCHITECTURE.md §20.1), shared by every agent.
 *
 * - `replay` (default): starts at `BROKERAGE_REPLAY_FROM` (default: the first trading day at least a
 *   year before the last close) and moves one trading day every `BROKERAGE_DAY_SECONDS` (default 20),
 *   so values and P/L move during a demo. It stops at the last close.
 * - `live`: always the last close (no intraday movement).
 *
 * Trading days are the dates of a reference ticker's closes (SPY when Quantcomm has it). The clock
 * knows no dates until that calendar loads, so a Quantcomm outage at startup only delays it.
 * Its position is persisted (brokerage.json), so a restart resumes where it was, without counting
 * the time it was down.
 */

export type PriceMode = "replay" | "live";

export interface ClockSettings {
  mode: PriceMode;
  /** YYYY-MM-DD, or undefined for "about a year before the last close". */
  replayFrom?: string;
  /** Seconds per trading day in replay mode. 0 = only moves when advanced by hand (tests). */
  daySeconds: number;
}

export interface ClockSnapshot {
  /** The setting it was started with (null: the default), so a changed setting restarts the replay. */
  replayFrom: string | null;
  startDate: string;
  date: string;
}

export interface ClockView {
  mode: PriceMode;
  /** Today's date in the brokerage (null until Quantcomm's calendar loads). */
  clockDate: string | null;
  /** First replayed day (live mode: the same default, used for "change from start"). */
  startDate: string | null;
  /** Quantcomm's last close. */
  lastDate: string | null;
  daySeconds: number;
  /** Replay only: when the next trading day starts, or null once it reached the last close. */
  nextDayAt: string | null;
  /** Replay only: it reached the last close and stays there. */
  caughtUp: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_DAY_SECONDS = 20;

/** BROKERAGE_PRICES, BROKERAGE_REPLAY_FROM, BROKERAGE_DAY_SECONDS (bad values fall back to the defaults, with a warning). */
export function clockSettingsFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = (m) => console.warn(`[brokerage] ${m}`)): ClockSettings {
  const rawMode = (env.BROKERAGE_PRICES ?? "").trim().toLowerCase();
  if (rawMode && rawMode !== "replay" && rawMode !== "live") warn(`BROKERAGE_PRICES must be "replay" or "live", not "${rawMode}"; using replay`);
  const mode: PriceMode = rawMode === "live" ? "live" : "replay";
  const rawFrom = (env.BROKERAGE_REPLAY_FROM ?? "").trim();
  let replayFrom: string | undefined;
  if (rawFrom) {
    if (DATE_RE.test(rawFrom) && !Number.isNaN(Date.parse(rawFrom))) replayFrom = rawFrom;
    else warn(`BROKERAGE_REPLAY_FROM must be a date like 2025-10-16, not "${rawFrom}"; starting a year before the last close`);
  }
  const rawDay = (env.BROKERAGE_DAY_SECONDS ?? "").trim();
  let daySeconds = DEFAULT_DAY_SECONDS;
  if (rawDay) {
    const n = Number(rawDay);
    if (Number.isFinite(n) && n >= 1 && n <= 86_400) daySeconds = n;
    else warn(`BROKERAGE_DAY_SECONDS must be between 1 and 86400, not "${rawDay}"; using ${DEFAULT_DAY_SECONDS}`);
  }
  return { mode, replayFrom, daySeconds };
}

/** "2026-10-16" minus one calendar year. */
export function yearBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y - 1, m - 1, d));
  return t.toISOString().slice(0, 10);
}

/** First trading day on or after `date` (the last one if `date` is past them all). */
function snapForward(calendar: readonly string[], date: string): number {
  const i = calendar.findIndex((d) => d >= date);
  return i === -1 ? calendar.length - 1 : i;
}

export class ReplayClock {
  readonly settings: ClockSettings;
  #calendar: string[] = [];
  #start = -1;
  #index = -1;
  #dayStartedAt = 0;
  readonly #now: () => number;
  readonly #onChange: (s: ClockSnapshot) => void;
  #restored: ClockSnapshot | undefined;

  constructor(settings: ClockSettings, opts: { restored?: ClockSnapshot; now?: () => number; onChange?: (s: ClockSnapshot) => void } = {}) {
    this.settings = settings;
    this.#restored = opts.restored;
    this.#now = opts.now ?? Date.now;
    this.#onChange = opts.onChange ?? (() => {});
  }

  get ready(): boolean {
    return this.#calendar.length > 0;
  }

  /**
   * Load or extend the trading calendar (dates ascending). The first load places the clock: the
   * restored position when it was started with the same setting, else the start date.
   */
  setCalendar(dates: readonly string[]): void {
    if (!dates.length) return;
    const first = !this.ready;
    const current = this.ready ? this.#calendar[this.#index] : undefined;
    const startDate = this.ready ? this.#calendar[this.#start] : undefined;
    this.#calendar = [...dates];
    if (!first) {
      // A new close arrived: keep the same dates.
      this.#start = snapForward(this.#calendar, startDate!);
      this.#index = snapForward(this.#calendar, current!);
      return;
    }
    const last = this.#calendar[this.#calendar.length - 1];
    const setting = this.settings.replayFrom ?? null;
    const r = this.#restored;
    if (r && r.replayFrom === setting && DATE_RE.test(r.startDate) && DATE_RE.test(r.date) && r.date >= r.startDate) {
      this.#start = snapForward(this.#calendar, r.startDate);
      this.#index = Math.max(this.#start, snapForward(this.#calendar, r.date));
    } else {
      this.#start = snapForward(this.#calendar, setting ?? yearBefore(last));
      this.#index = this.#start;
    }
    if (this.settings.mode === "live") this.#index = this.#calendar.length - 1;
    this.#restored = undefined;
    this.#dayStartedAt = this.#now();
    this.#changed();
  }

  /** The clock's date (null until the calendar loads). */
  date(): string | null {
    if (!this.ready) return null;
    return this.settings.mode === "live" ? this.#calendar[this.#calendar.length - 1] : this.#calendar[this.#index];
  }

  startDate(): string | null {
    return this.ready ? this.#calendar[this.#start] : null;
  }

  lastDate(): string | null {
    return this.ready ? this.#calendar[this.#calendar.length - 1] : null;
  }

  /** The trading day before the clock's date (for 1-day change), or null on the first day of the calendar. */
  previousDate(): string | null {
    if (!this.ready) return null;
    const i = this.settings.mode === "live" ? this.#calendar.length - 1 : this.#index;
    return i > 0 ? this.#calendar[i - 1] : null;
  }

  /** Move `days` trading days (replay only; stops at the last close). Returns how many it moved. */
  advance(days = 1): number {
    if (!this.ready || this.settings.mode !== "replay") return 0;
    const target = Math.min(this.#calendar.length - 1, Math.max(this.#index, this.#index + Math.floor(days)));
    const moved = target - this.#index;
    this.#dayStartedAt = this.#now();
    if (moved > 0) {
      this.#index = target;
      this.#changed();
    }
    return moved;
  }

  /** The timer's tick: one trading day. */
  tick(): boolean {
    return this.advance(1) > 0;
  }

  view(): ClockView {
    const caughtUp = this.ready && this.settings.mode === "replay" && this.#index >= this.#calendar.length - 1;
    const timed = this.ready && this.settings.mode === "replay" && this.settings.daySeconds > 0 && !caughtUp;
    return {
      mode: this.settings.mode,
      clockDate: this.date(),
      startDate: this.startDate(),
      lastDate: this.lastDate(),
      daySeconds: this.settings.daySeconds,
      nextDayAt: timed ? new Date(this.#dayStartedAt + this.settings.daySeconds * 1000).toISOString() : null,
      caughtUp,
    };
  }

  snapshot(): ClockSnapshot | undefined {
    if (!this.ready) return this.#restored;
    return { replayFrom: this.settings.replayFrom ?? null, startDate: this.#calendar[this.#start], date: this.#calendar[this.#index] };
  }

  #changed(): void {
    const s = this.snapshot();
    if (s) this.#onChange(s);
  }
}
