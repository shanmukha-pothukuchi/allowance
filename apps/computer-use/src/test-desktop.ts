/**
 * Test doubles: a desktop driver without Docker and a clock tests can move.
 */
import { DesktopError, type ActionRequest, type ActionResult, type Desktop, type DesktopDriver, type TextSnapshot } from "./desktop.js";
import type { Clock } from "./sessions.js";

/** A 1x1 PNG. */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
/** A minimal JPEG (SOI … EOI). */
export const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);

export const SNAPSHOT: TextSnapshot = {
  url: "https://example.com/",
  title: "Example Domain",
  text: "Example Domain\nThis domain is for use in examples.\n[1] More information… [2] Search [3] (textbox) [4] Password",
  elements: [
    { n: 1, role: "link", label: "More information…", x: 200, y: 300, w: 120, h: 18, href: "https://www.iana.org/domains/example" },
    { n: 2, role: "button", label: "Search", x: 400, y: 120, w: 60, h: 24 },
    { n: 3, role: "textbox", label: "q", x: 300, y: 120, w: 200, h: 24 },
    { n: 4, role: "textbox", label: "Password", x: 300, y: 160, w: 200, h: 24, type: "password" },
  ],
  scroll: { y: 0, maxY: 0, more: "none" },
};

export class FakeDesktop implements Desktop {
  page = { url: "about:blank", title: "" };
  actions: ActionRequest[] = [];
  stopped = false;
  /** The next act() throws this (a failure inside the desktop, after payment). */
  failNext?: DesktopError;
  streams = 0;

  constructor(
    readonly name: string,
    private readonly driver: FakeDesktopDriver,
  ) {}

  async snapshot(): Promise<TextSnapshot> {
    if (this.stopped) throw new DesktopError(503, "desktop_unavailable", "stopped");
    return { ...SNAPSHOT, url: this.page.url === "about:blank" ? SNAPSHOT.url : this.page.url };
  }

  async screenshot(format: "png" | "jpeg") {
    if (this.stopped) throw new DesktopError(503, "desktop_unavailable", "stopped");
    return format === "png" ? { contentType: "image/png", data: TINY_PNG } : { contentType: "image/jpeg", data: TINY_JPEG };
  }

  async act(action: ActionRequest): Promise<ActionResult> {
    if (this.stopped) throw new DesktopError(503, "desktop_unavailable", "stopped");
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    this.actions.push(action);
    if (action.kind === "navigate") this.page = { url: String(action.url), title: "Example Domain" };
    if (action.kind === "click" && action.element === 1) this.page = { url: "https://www.iana.org/domains/example", title: "IANA" };
    if (action.kind === "click" && typeof action.element === "number" && action.element > SNAPSHOT.elements.length) {
      throw new DesktopError(404, "element_not_found", `There is no element ${action.element} in the last snapshot.`);
    }
    return { ok: true, ...this.page };
  }

  async stream(signal: AbortSignal) {
    this.streams++;
    const frame = Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${TINY_JPEG.length}\r\n\r\n`), TINY_JPEG, Buffer.from("\r\n")]);
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(frame));
        timer = setInterval(() => controller.enqueue(new Uint8Array(frame)), 20);
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          try {
            controller.close();
          } catch {
            /* closed */
          }
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return { contentType: "multipart/x-mixed-replace; boundary=frame", body };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.driver.stopped.push(this.name);
  }
}

export class FakeDesktopDriver implements DesktopDriver {
  available = true;
  failStart = false;
  startDelayMs = 0;
  started: string[] = [];
  stopped: string[] = [];
  cleanups = 0;
  readonly desktops = new Map<string, FakeDesktop>();

  async check(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.available ? { ok: true } : { ok: false, reason: "Docker isn't reachable on this machine." };
  }

  async start(sessionId: string): Promise<Desktop> {
    this.started.push(sessionId);
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs));
    if (this.failStart) throw new DesktopError(503, "desktop_failed", "The desktop couldn't start: test");
    const d = new FakeDesktop(`allowance-cu-${sessionId}`, this);
    this.desktops.set(sessionId, d);
    return d;
  }

  async cleanup(): Promise<void> {
    this.cleanups++;
    for (const d of this.desktops.values()) await d.stop();
  }
}

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(public t = Date.parse("2026-10-18T12:00:00Z")) {}

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  /** Move time forward, running every timer that comes due (in order, including ones they schedule). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
  }
}
