/**
 * The desktop layer behind an interface, so the queue, lease and payment logic can be tested
 * without Docker (test-desktop.ts) and run for real against containers (docker.ts).
 */
import { isActionKind, type ActionKind } from "./prices.js";

export const SCREEN = { width: 1280, height: 800 } as const;

/** One numbered interactive element of a text snapshot. x/y are screen pixels of its center. */
export interface SnapshotElement {
  n: number;
  role: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  href?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  disabled?: boolean;
}

export interface TextSnapshot {
  url: string;
  title: string;
  /** The viewport's visible text; "[n]" marks element n. */
  text: string;
  elements: SnapshotElement[];
  scroll: { y: number; maxY: number; more: string };
  truncated?: boolean;
  moreElements?: boolean;
  note?: string;
}

export type ActionRequest = { kind: ActionKind } & Record<string, unknown>;

export interface ActionResult {
  ok: true;
  url: string;
  title: string;
  [k: string]: unknown;
}

export interface Desktop {
  /** The container name (allowance-cu-…). */
  readonly name: string;
  snapshot(): Promise<TextSnapshot>;
  screenshot(format: "png" | "jpeg"): Promise<{ contentType: string; data: Buffer }>;
  act(action: ActionRequest): Promise<ActionResult>;
  /** The live MJPEG stream (multipart/x-mixed-replace; boundary=frame). */
  stream(signal: AbortSignal): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }>;
  stop(): Promise<void>;
}

export interface DesktopDriver {
  /** Can desktops be started right now (Docker reachable, image built)? */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  start(sessionId: string): Promise<Desktop>;
  /** Remove every desktop this driver started (and leftovers of a previous run of this service). */
  cleanup(): Promise<void>;
}

/** A failure inside the desktop. Always answered with its status (≥ 400), so a paid request is never settled. */
export class DesktopError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

/** A request the service refuses (before or after the paywall). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ---- action validation (the same rules run before the paywall when a body is present, and after it) ----

const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);
const bad = (message: string) => new HttpError(400, "invalid_action", message);

function target(body: Record<string, unknown>, kind: string, required: boolean): void {
  const hasEl = body.element !== undefined;
  const hasXY = body.x !== undefined || body.y !== undefined;
  if (hasEl && !(isInt(body.element) && (body.element as number) >= 1)) throw bad("element must be a number from the last snapshot, e.g. 12.");
  if (hasXY) {
    if (!isInt(body.x) || !isInt(body.y)) throw bad("x and y must both be whole screen pixels.");
    const x = body.x as number;
    const y = body.y as number;
    if (x < 0 || y < 0 || x >= SCREEN.width || y >= SCREEN.height) throw bad(`x,y must be on the ${SCREEN.width}x${SCREEN.height} screen.`);
  }
  if (required && !hasEl && !hasXY) throw bad(`${kind} needs element (a number from the snapshot) or x and y.`);
}

/** Luhn-valid runs of 13–19 digits (spaces and dashes allowed): what a card number looks like. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\d[\d -]{11,22}\d/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * Checks an action body and returns the clean action the desktop gets. Throws HttpError(400/422).
 * `passwordFields`: element numbers the last snapshot showed as password inputs.
 */
export function parseAction(kind: string, raw: unknown, passwordFields: ReadonlySet<number> = new Set()): ActionRequest {
  if (!isActionKind(kind)) throw new HttpError(404, "unknown_action", `Unknown action "${kind}". Actions: navigate, click, type, key, scroll, select, hover, back, forward, reload.`);
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: ActionRequest = { kind };
  const copy = (...keys: string[]) => {
    for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  };
  switch (kind) {
    case "navigate": {
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!url || url.length > 2000) throw bad('navigate needs url, e.g. { "url": "https://example.com" }.');
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url) && !/^[\w.-]+:\d+/.test(url)) throw bad("Only http(s) URLs can be opened.");
      out.url = url;
      return out;
    }
    case "click":
    case "hover":
      target(body, kind, true);
      if (body.button !== undefined && !["left", "middle", "right"].includes(String(body.button))) throw bad('button is "left", "middle" or "right".');
      if (body.count !== undefined && body.count !== 1 && body.count !== 2) throw bad("count is 1 or 2 (double click).");
      copy("element", "x", "y", "button", "count");
      return out;
    case "type": {
      if (typeof body.text !== "string" || !body.text) throw bad('type needs text, e.g. { "element": 7, "text": "hello" }.');
      if (body.text.length > 2000) throw bad("text can be at most 2000 characters.");
      target(body, kind, false);
      for (const k of ["submit", "clear"]) if (body[k] !== undefined && typeof body[k] !== "boolean") throw bad(`${k} is true or false.`);
      if (looksLikeCardNumber(body.text)) {
        throw new HttpError(422, "card_number_refused", "That looks like a card number. Never type card numbers into the computer; pay with your wallet tools instead. Nothing was charged.");
      }
      if (isInt(body.element) && passwordFields.has(body.element as number)) {
        throw new HttpError(422, "password_field_refused", `Element ${body.element} is a password field. Never type passwords into the computer; ask your owner instead. Nothing was charged.`);
      }
      copy("text", "element", "x", "y", "submit", "clear");
      return out;
    }
    case "key": {
      const keys = typeof body.keys === "string" ? body.keys.trim() : "";
      if (!keys || keys.length > 100 || !/^[A-Za-z0-9_+ ]+$/.test(keys)) throw bad('key needs keys, e.g. { "keys": "Enter" }, "ctrl+a" or "Tab Tab Enter".');
      out.keys = keys;
      return out;
    }
    case "scroll":
      if (body.direction !== undefined && !["up", "down", "left", "right"].includes(String(body.direction))) throw bad('direction is "up", "down", "left" or "right".');
      if (body.amount !== undefined && !(isInt(body.amount) && (body.amount as number) >= 1 && (body.amount as number) <= 15)) throw bad("amount is 1–15 wheel steps (default 5).");
      target(body, kind, false);
      out.direction = body.direction ?? "down";
      copy("amount", "element", "x", "y");
      return out;
    case "select":
      if (!(isInt(body.element) && (body.element as number) >= 1)) throw bad('select needs element (a dropdown from the snapshot) and value, e.g. { "element": 4, "value": "Blue" }.');
      if (typeof body.value !== "string" || !body.value.trim()) throw bad("select needs value: the option's text or value.");
      copy("element", "value");
      return out;
    case "back":
    case "forward":
    case "reload":
      return out;
  }
}
