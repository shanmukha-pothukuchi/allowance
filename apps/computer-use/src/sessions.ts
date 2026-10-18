/**
 * Seats, the queue and time leases (docs/ARCHITECTURE.md §19.2).
 *
 * - A session gets a seat if one is free (status "active"), else it waits in line ("queued").
 * - An active session holds a lease bought in one-minute blocks. The first block must be bought
 *   within the start grace (the seat is reserved meanwhile); when the lease runs out without renewal
 *   the session ends, its desktop is removed and the next in line gets the seat.
 * - Sessions belong to whoever created them: a control token (actions, time, end) and a view token
 *   (status, viewer, stream). Only their hashes are kept.
 *
 * Time comes from an injectable clock so tests can move it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "@allowance/shared";
import { HttpError, type Desktop, type DesktopDriver, type TextSnapshot } from "./desktop.js";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SessionStatus = "queued" | "active" | "ended";
export type EndReason = "ended" | "cancelled" | "lease_lapsed" | "not_started" | "desktop_failed" | "service_stopped";
export type DesktopState = "none" | "starting" | "ready" | "failed" | "stopped";

export const END_MESSAGES: Record<EndReason, string> = {
  ended: "You ended the session.",
  cancelled: "You cancelled the session before it started; nothing was charged.",
  lease_lapsed: "The time ran out without being renewed, so the session ended.",
  not_started: "No time was bought in time after the seat was ready, so the seat went to the next in line; nothing was charged.",
  desktop_failed: "The desktop couldn't start; nothing was charged for it.",
  service_stopped: "The computer service stopped.",
};

export interface Spend {
  time: bigint;
  actions: bigint;
  reads: bigint;
  actionCount: number;
  readCount: number;
}

export interface Session {
  id: string;
  label?: string;
  status: SessionStatus;
  createdAt: number;
  activatedAt?: number;
  /** When the first block was bought. */
  leaseStartedAt?: number;
  leaseEndsAt?: number;
  /** Active without a lease yet: the first block must be bought before this. */
  payBy?: number;
  endedAt?: number;
  endReason?: EndReason;
  seat?: number;
  minutesBought: number;
  spend: Spend;
  desktopState: DesktopState;
  desktopError?: string;
  desktop?: Desktop;
  /** Paid requests between "passed the checks" and "response closed"; the lease waits for them. */
  inFlight: number;
  page?: { url: string; title: string };
  lastAction?: { kind: string; at: number; ok: boolean; message?: string };
  /** Element numbers the last snapshot showed as password inputs (typing into them is refused). */
  passwordFields: Set<number>;
  /** Ends live streams when the session ends. */
  abort: AbortController;
  readonly tokenHash: Buffer;
  readonly viewTokenHash: Buffer;
  /** @internal */
  ready?: Promise<Desktop>;
  /** @internal */
  timer?: unknown;
  /** @internal serializes desktop work */
  chain: Promise<unknown>;
}

export interface SessionManagerOptions {
  driver: DesktopDriver;
  seats: number;
  maxQueue: number;
  startGraceMs: number;
  maxSessionMs: number;
  maxLeaseAheadMs: number;
  clock?: Clock;
  log?: (msg: string) => void;
  /** How long ended sessions stay readable (default 15 min). */
  keepEndedMs?: number;
  /** Called on every change (the viewer polls; this is for logs and tests). */
  onChange?: (s: Session) => void;
}

const MINUTE = 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest();

export type Access = "control" | "view";

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  readonly queue: Session[] = [];
  private readonly seatsTaken = new Map<number, string>();
  private readonly clock: Clock;
  private readonly log: (msg: string) => void;
  private stopping = false;

  constructor(private readonly opts: SessionManagerOptions) {
    this.clock = opts.clock ?? realClock;
    this.log = opts.log ?? (() => {});
  }

  get seats(): number {
    return this.opts.seats;
  }
  get activeCount(): number {
    return this.seatsTaken.size;
  }
  get maxSessionMs(): number {
    return this.opts.maxSessionMs;
  }
  get maxLeaseAheadMs(): number {
    return this.opts.maxLeaseAheadMs;
  }
  now(): number {
    return this.clock.now();
  }

  // ---- create / find ------------------------------------------------------------------------------

  create(label?: string): { session: Session; token: string; viewToken: string } {
    if (this.stopping) throw new HttpError(503, "computer_unavailable", "The computer service is stopping; nothing was charged.");
    const free = this.freeSeat();
    if (free === undefined && this.queue.length >= this.opts.maxQueue) {
      throw new HttpError(503, "queue_full", `All ${this.opts.seats} seat${this.opts.seats === 1 ? " is" : "s are"} busy and ${this.queue.length} sessions are waiting; try again later. Nothing was charged.`);
    }
    const token = `cut_${randomBytes(24).toString("hex")}`;
    const viewToken = `cuv_${randomBytes(16).toString("hex")}`;
    const s: Session = {
      id: newId("cus"),
      ...(label ? { label } : {}),
      status: "queued",
      createdAt: this.clock.now(),
      minutesBought: 0,
      spend: { time: 0n, actions: 0n, reads: 0n, actionCount: 0, readCount: 0 },
      desktopState: "none",
      inFlight: 0,
      passwordFields: new Set(),
      abort: new AbortController(),
      tokenHash: sha(token),
      viewTokenHash: sha(viewToken),
      chain: Promise.resolve(),
    };
    this.sessions.set(s.id, s);
    if (free !== undefined) this.activate(s, free);
    else {
      this.queue.push(s);
      this.log(`session ${s.id} queued at ${this.queue.length}`);
      this.changed(s);
    }
    return { session: s, token, viewToken };
  }

  /** The session behind an id and token. 404 unknown id · 401 no token · 403 wrong token (or a view token for control). */
  authorize(id: string, token: unknown, need: Access): { session: Session; access: Access } {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, "session_not_found", "There is no such computer session (it may have ended a while ago).");
    if (typeof token !== "string" || !token) throw new HttpError(401, "token_required", "Add the session token: ?token=<token from POST /computer/sessions>.");
    const h = sha(token);
    if (timingSafeEqual(h, s.tokenHash)) return { session: s, access: "control" };
    if (timingSafeEqual(h, s.viewTokenHash)) {
      if (need === "control") throw new HttpError(403, "view_only", "That is the view-only link's token; actions need the session token.");
      return { session: s, access: "view" };
    }
    throw new HttpError(403, "wrong_token", "That token doesn't belong to this session.");
  }

  // ---- queue --------------------------------------------------------------------------------------

  position(s: Session): number {
    return this.queue.indexOf(s) + 1;
  }

  /**
   * Rough wait for a queued session: each seat frees when its lease ends (or its start grace runs
   * out), and every session ahead is assumed to use 3 minutes once it starts.
   */
  estimatedWaitMs(s: Session): number {
    const pos = this.position(s);
    if (pos <= 0) return 0;
    const now = this.clock.now();
    const free: number[] = [];
    for (const id of this.seatsTaken.values()) {
      const a = this.sessions.get(id);
      free.push(Math.max(0, (a?.leaseEndsAt ?? a?.payBy ?? now) - now));
    }
    while (free.length < this.opts.seats) free.push(0);
    const assumed = 3 * MINUTE;
    let wait = 0;
    for (let i = 0; i < pos; i++) {
      free.sort((a, b) => a - b);
      wait = free[0];
      free[0] = wait + assumed;
    }
    return wait;
  }

  private freeSeat(): number | undefined {
    for (let i = 1; i <= this.opts.seats; i++) if (!this.seatsTaken.has(i)) return i;
    return undefined;
  }

  private promote(): void {
    if (this.stopping) return;
    for (let seat = this.freeSeat(); seat !== undefined && this.queue.length; seat = this.freeSeat()) {
      const next = this.queue.shift()!;
      this.activate(next, seat);
    }
  }

  private activate(s: Session, seat: number): void {
    const now = this.clock.now();
    s.status = "active";
    s.seat = seat;
    s.activatedAt = now;
    s.payBy = now + this.opts.startGraceMs;
    s.desktopState = "starting";
    this.seatsTaken.set(seat, s.id);
    this.log(`session ${s.id} active on seat ${seat}; first minute due within ${Math.round(this.opts.startGraceMs / 1000)} s`);
    s.ready = this.opts.driver.start(s.id).then(
      async (d) => {
        if (s.status !== "active") {
          await d.stop().catch(() => undefined);
          throw new HttpError(410, "session_ended", END_MESSAGES[s.endReason ?? "ended"]);
        }
        s.desktop = d;
        s.desktopState = "ready";
        this.changed(s);
        return d;
      },
      (err: Error) => {
        s.desktopState = "failed";
        s.desktopError = err.message;
        this.log(`session ${s.id}: desktop failed: ${err.message}`);
        this.end(s, "desktop_failed");
        throw err;
      },
    );
    s.ready.catch(() => undefined);
    this.arm(s);
    this.changed(s);
  }

  // ---- lease --------------------------------------------------------------------------------------

  /** ms of lease left (0 when none or lapsed). */
  leaseLeftMs(s: Session): number {
    return s.leaseEndsAt ? Math.max(0, s.leaseEndsAt - this.clock.now()) : 0;
  }

  /** Before the paywall: can `minutes` be bought now? */
  checkBuy(s: Session, minutes: number): void {
    this.checkLive(s);
    const now = this.clock.now();
    const left = this.leaseLeftMs(s);
    const add = minutes * MINUTE;
    if (left + add > this.opts.maxLeaseAheadMs) {
      const room = Math.floor((this.opts.maxLeaseAheadMs - left) / MINUTE);
      throw new HttpError(409, "lease_full", `The lease already has ${Math.ceil(left / 1000)} s left; it can hold at most ${Math.round(this.opts.maxLeaseAheadMs / MINUTE)} minutes ahead. ${room > 0 ? `Buy at most ${room} now.` : "Buy more later."} Nothing was charged.`);
    }
    const start = s.leaseStartedAt ?? now;
    const end = Math.max(now, s.leaseEndsAt ?? now) + add;
    if (end - start > this.opts.maxSessionMs) {
      throw new HttpError(409, "session_limit", `A session lasts at most ${Math.round(this.opts.maxSessionMs / MINUTE)} minutes; end this one and start a new one. Nothing was charged.`);
    }
  }

  /** Before the paywall: can the session act or read now? */
  checkUse(s: Session): void {
    this.checkLive(s);
    if (!s.leaseEndsAt) {
      throw new HttpError(409, "lease_required", "Buy time first: POST …/time (the first minute starts the session). Nothing was charged.");
    }
    if (this.leaseLeftMs(s) <= 0) throw new HttpError(410, "lease_lapsed", END_MESSAGES.lease_lapsed);
    if (s.desktopState === "failed") throw new HttpError(503, "desktop_unavailable", "The desktop isn't running; nothing was charged.");
  }

  private checkLive(s: Session): void {
    if (s.status === "ended") {
      throw new HttpError(410, "session_ended", `${END_MESSAGES[s.endReason ?? "ended"]} Start a new session with POST /computer/sessions.`, { endReason: s.endReason });
    }
    if (s.status === "queued") {
      throw new HttpError(409, "session_queued", `This session is still in line (position ${this.position(s)}). Poll its status (free) until it is active; nothing was charged.`, {
        position: this.position(s),
      });
    }
  }

  /** After settlement: add the minutes to the lease (from now, or from its end if still running). */
  grantTime(s: Session, minutes: number, amount: bigint): void {
    if (s.status !== "active") {
      this.log(`session ${s.id}: paid ${minutes} min after it ended (${s.endReason})`);
      s.spend.time += amount;
      return;
    }
    const now = this.clock.now();
    s.leaseEndsAt = Math.max(now, s.leaseEndsAt ?? now) + minutes * MINUTE;
    s.leaseStartedAt ??= now;
    s.payBy = undefined;
    s.minutesBought += minutes;
    s.spend.time += amount;
    this.arm(s);
    this.changed(s);
  }

  recordUse(s: Session, kind: "action" | "read", amount: bigint): void {
    if (kind === "action") {
      s.spend.actions += amount;
      s.spend.actionCount += 1;
    } else {
      s.spend.reads += amount;
      s.spend.readCount += 1;
    }
    this.changed(s);
  }

  /** The desktop, once it is up (waits while it is starting). */
  async desktop(s: Session, timeoutMs = 60_000): Promise<Desktop> {
    if (s.desktop && s.desktopState === "ready") return s.desktop;
    if (!s.ready) throw new HttpError(503, "desktop_unavailable", "The desktop isn't running; nothing was charged.");
    let timer: unknown;
    try {
      return await Promise.race([
        s.ready,
        new Promise<never>((_r, reject) => {
          timer = this.clock.setTimeout(() => reject(new HttpError(503, "desktop_unavailable", "The desktop is taking too long to start; nothing was charged.")), timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "desktop_unavailable", `The desktop isn't running (${(err as Error).message}); nothing was charged.`);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  /** Run desktop work one at a time per session. */
  serialize<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const run = s.chain.then(fn, fn);
    s.chain = run.catch(() => undefined);
    return run;
  }

  noteSnapshot(s: Session, snap: TextSnapshot): void {
    s.page = { url: snap.url, title: snap.title };
    s.passwordFields = new Set(snap.elements.filter((e) => e.role === "textbox" && e.type === "password").map((e) => e.n));
  }

  noteAction(s: Session, kind: string, ok: boolean, page?: { url?: unknown; title?: unknown }, message?: string): void {
    s.lastAction = { kind, at: this.clock.now(), ok, ...(message ? { message } : {}) };
    if (ok && page && typeof page.url === "string") {
      if (page.url !== s.page?.url) s.passwordFields = new Set();
      s.page = { url: page.url, title: typeof page.title === "string" ? page.title : "" };
    }
    this.changed(s);
  }

  // ---- timers -------------------------------------------------------------------------------------

  private arm(s: Session): void {
    if (s.timer !== undefined) this.clock.clearTimeout(s.timer);
    s.timer = undefined;
    if (s.status !== "active") return;
    const due = s.leaseEndsAt ?? s.payBy;
    if (due === undefined) return;
    s.timer = this.clock.setTimeout(() => this.onDue(s), Math.max(0, due - this.clock.now()));
  }

  private onDue(s: Session): void {
    s.timer = undefined;
    if (s.status !== "active") return;
    const now = this.clock.now();
    const due = s.leaseEndsAt ?? s.payBy ?? now;
    if (due > now) return this.arm(s);
    // A paid request in flight (a renewal settling, or an action running) finishes first.
    if (s.inFlight > 0) {
      s.timer = this.clock.setTimeout(() => this.onDue(s), 500);
      return;
    }
    this.end(s, s.leaseEndsAt ? "lease_lapsed" : "not_started");
  }

  // ---- end ----------------------------------------------------------------------------------------

  end(s: Session, reason: EndReason): void {
    if (s.status === "ended") return;
    const wasQueued = s.status === "queued";
    if (s.timer !== undefined) this.clock.clearTimeout(s.timer);
    s.timer = undefined;
    s.status = "ended";
    s.endedAt = this.clock.now();
    s.endReason = wasQueued && reason === "ended" ? "cancelled" : reason;
    s.payBy = undefined;
    s.abort.abort();
    const qi = this.queue.indexOf(s);
    if (qi >= 0) this.queue.splice(qi, 1);
    if (s.seat !== undefined && this.seatsTaken.get(s.seat) === s.id) this.seatsTaken.delete(s.seat);
    this.log(`session ${s.id} ended (${s.endReason})`);
    const d = s.desktop;
    s.desktop = undefined;
    if (s.desktopState !== "failed" && s.desktopState !== "none") s.desktopState = "stopped";
    if (d) void d.stop().catch((err: Error) => this.log(`stopping ${d.name} failed: ${err.message}`));
    // A desktop still starting is stopped by activate()'s handler when it comes up.
    this.clock.setTimeout(() => this.sessions.delete(s.id), this.opts.keepEndedMs ?? 15 * MINUTE);
    this.changed(s);
    this.promote();
  }

  /** Stop: end every session and remove every desktop. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const live = [...this.sessions.values()].filter((s) => s.status !== "ended");
    for (const s of live) this.end(s, "service_stopped");
    await Promise.allSettled(live.map((s) => s.ready?.then((d) => d.stop())));
    await this.opts.driver.cleanup();
  }

  private changed(s: Session): void {
    this.opts.onChange?.(s);
  }
}
