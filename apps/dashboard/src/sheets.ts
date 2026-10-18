/**
 * Owner sheets (§14.3): "New agent" and "Add money". Pure helpers only (validation, presets,
 * amounts, URLs, the embed postMessage contract, chat registration), so they are unit-tested in
 * sheets.test.ts. No React here.
 */
import { fromCents, money, toCents } from "./format";
import type { CreateAgentRequest, Policy } from "./types";
// The shared contract's constants. Imported from the pure types file directly: the package's
// main entry also exports a node:fs config loader that must never reach the browser bundle.
import { AGENT_NAME_RE, MAX_TOPUP } from "@allowance/shared/types";

export { AGENT_NAME_RE, MAX_TOPUP };

// ---------------------------------------------------------------------------- routes

/** The sheets the chat can embed (§14.3); their ids ride on the postMessage contract. */
export type SheetId = "new-agent" | "add-money";
export type EmbedSheetRoute = { sheet: "new-agent" } | { sheet: "add-money"; agent?: string };
/** Plus "Add a Shopify store" (§15.5), which lives on the dashboard only. */
export type SheetRoute = EmbedSheetRoute | { sheet: "add-shopify" };

/** `?sheet=new-agent` / `?sheet=add-money&agent=<name>` / `?sheet=add-shopify` → the sheet to show, else null. */
export function sheetFromSearch(search: string): SheetRoute | null {
  const p = new URLSearchParams(search);
  const sheet = p.get("sheet");
  if (sheet === "new-agent" || sheet === "add-shopify") return { sheet };
  if (sheet === "add-money") {
    const agent = p.get("agent")?.trim();
    return agent ? { sheet, agent } : { sheet };
  }
  return null;
}

export function embedRequested(search: string): boolean {
  const e = new URLSearchParams(search).get("embed");
  return e === "1" || e === "true";
}

/** `?sheet=…&embed=1` → the sheet to render alone for the chat, else null (add-shopify is dashboard-only). */
export function embedSheet(search: string): EmbedSheetRoute | null {
  if (!embedRequested(search)) return null;
  const r = sheetFromSearch(search);
  return r && r.sheet !== "add-shopify" ? r : null;
}

/** The query string with the sheet params set (or removed), keeping everything else (mock, theme). */
export function withSheet(search: string, route: SheetRoute | null): string {
  const p = new URLSearchParams(search);
  p.delete("sheet");
  p.delete("agent");
  if (route) {
    p.set("sheet", route.sheet);
    if (route.sheet === "add-money" && route.agent) p.set("agent", route.agent);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------- chat server

export const DEFAULT_CHAT_URL = "http://localhost:4050";

/** `VITE_AGENT_CHAT_URL` (http/https only), else the default; no trailing slash. */
export function chatUrlFrom(env: Record<string, unknown> = import.meta.env ?? {}): string {
  const raw = typeof env.VITE_AGENT_CHAT_URL === "string" ? env.VITE_AGENT_CHAT_URL.trim() : "";
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href.replace(/\/+$/, "");
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_CHAT_URL;
}

export const chatLinkFor = (chatUrl: string, name: string) => `${chatUrl}/?agent=${encodeURIComponent(name)}`;

/** The chat origin plus its localhost ⇄ 127.0.0.1 twin. */
export function chatOrigins(chatUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(chatUrl);
  } catch {
    return [];
  }
  const out = [u.origin];
  const port = u.port ? `:${u.port}` : "";
  if (u.hostname === "localhost") out.push(`${u.protocol}//127.0.0.1${port}`);
  else if (u.hostname === "127.0.0.1") out.push(`${u.protocol}//localhost${port}`);
  return out;
}

/**
 * Where an embedded sheet may post: the chat (either host spelling) and the dashboard itself
 * (it may frame its own pages; CSP frame-ancestors allows exactly these). Never "*".
 */
export function postTargets(chatUrl: string, selfOrigin?: string): string[] {
  return [...new Set([...chatOrigins(chatUrl), ...(selfOrigin ? [selfOrigin] : [])])];
}

/** `http://localhost:4050/?agent=x` → `http://localhost:4050`; anything unparsable → null. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const o = new URL(url).origin;
    return o && o !== "null" ? o : null;
  } catch {
    return null;
  }
}

/**
 * The one origin to post to: the parent's real origin when we can learn it and it is allowed
 * (Chrome's `location.ancestorOrigins`, else `document.referrer`; the chat's iframe sends
 * `referrerpolicy="origin"`), otherwise the configured chat origin. A disallowed parent gets the
 * chat origin, which the browser will not deliver to it.
 */
export function pickTarget(allowed: string[], chatUrl: string, parentHints: (string | null | undefined)[]): string {
  for (const hint of parentHints) {
    const o = originOf(hint);
    if (o && allowed.includes(o)) return o;
  }
  return originOf(chatUrl) ?? DEFAULT_CHAT_URL;
}

export type ChatRegistration = { ok: true } | { ok: false; reason: string };

/**
 * Hand the new agent's token to the chat server (`POST {chat}/api/agents`, §14.1). The token is
 * sent in the body only; nothing here logs it.
 */
export async function registerWithChat(
  chatUrl: string,
  body: { name: string; token: string; role?: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<ChatRegistration> {
  const where = chatUrl.replace(/^https?:\/\//, "");
  let res: Response;
  try {
    res = await fetchImpl(`${chatUrl}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.role ? body : { name: body.name, token: body.token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: `The chat server at ${where} is not reachable.` };
  }
  if (res.ok) return { ok: true };
  let code = "";
  let message = "";
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    code = j.error ?? "";
    message = j.message ?? "";
  } catch {
    /* non-JSON error */
  }
  if (code === "agent_exists") return { ok: false, reason: `The chat server already has an agent named ${body.name}.` };
  if (code === "invalid_token") return { ok: false, reason: "The chat server could not verify the new agent with the wallet." };
  if (res.status === 503) return { ok: false, reason: "The chat server could not reach the wallet." };
  return { ok: false, reason: `The chat server said: ${message || `${res.status} ${res.statusText}`.trim()}` };
}

// ---------------------------------------------------------------------------- names

export const NAME_RULE = "Lowercase letters, numbers and dashes, 2 to 32 characters, starting with a letter or number.";

export type NameCheck = { ok: true; message: string } | { ok: false; empty?: boolean; message: string };

/** What the owner types → what we keep: lowercase, spaces and underscores become dashes. */
export function normalizeNameInput(raw: string): string {
  return raw.toLowerCase().replace(/[\s_]+/g, "-");
}

/** Live name check: the rule in plain words, then "is it taken". `AGENT_NAME_RE` is the authority. */
export function checkName(name: string, taken: Iterable<string> = []): NameCheck {
  if (!name) return { ok: false, empty: true, message: NAME_RULE };
  if (/[A-Z]/.test(name)) return { ok: false, message: "Use lowercase letters only." };
  if (/[^a-z0-9-]/.test(name)) return { ok: false, message: "Only letters, numbers and dashes. No spaces or other symbols." };
  if (name.startsWith("-")) return { ok: false, message: "Start with a letter or a number, not a dash." };
  if (name.length < 2) return { ok: false, message: "At least 2 characters." };
  if (name.length > 32) return { ok: false, message: `At most 32 characters (this is ${name.length}).` };
  if (!AGENT_NAME_RE.test(name)) return { ok: false, message: NAME_RULE };
  for (const t of taken) if (t.toLowerCase() === name) return { ok: false, message: `${name} is taken. Pick another name.` };
  return { ok: true, message: `${name} is available.` };
}

export const MAX_PURPOSE = 600;

// ---------------------------------------------------------------------------- amounts

export type AmountCheck = { ok: true; amount: string; cents: number } | { ok: false; empty?: boolean; message: string };

/** The chips on both sheets. */
export const AMOUNT_CHIPS = ["5.00", "10.00", "20.00", "50.00"] as const;

/**
 * Parse what the owner typed ("20", "12.5", "$1,000") into a wire dollar string, within
 * [min, max]. Defaults: $0.01 to MAX_TOPUP ($1000), the wallet's top-up range (§14.2).
 */
export function parseAmount(raw: string, opts: { min?: string; max?: string } = {}): AmountCheck {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!s) return { ok: false, empty: true, message: "Enter an amount." };
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(s)) {
    return { ok: false, message: /^\d*\.\d{3,}$/.test(s) ? "Use at most 2 decimals (cents)." : "Enter an amount like 20 or 12.50." };
  }
  const cents = toCents(s);
  const min = toCents(opts.min ?? "0.01");
  const max = toCents(opts.max ?? MAX_TOPUP);
  if (cents < min) return { ok: false, message: min === 0 ? "Can't be negative." : `At least ${money(fromCents(min))}.` };
  if (cents > max) return { ok: false, message: `At most ${money(fromCents(max))} at a time.` };
  return { ok: true, amount: fromCents(cents), cents };
}

/** "$5" for whole dollars, "$12.50" otherwise: chip and preset labels. */
export function shortMoney(amount: string): string {
  const m = money(amount);
  return m.endsWith(".00") ? m.slice(0, -3) : m;
}

/** "20.00" → "20", "12.50" → "12.50": a wire amount as the owner would type it. */
export function amountInput(amount: string): string {
  return shortMoney(amount).replace(/^\$/, "").replace(/,/g, "");
}

// ---------------------------------------------------------------------------- limits

export interface Limits {
  maxPerTx: string;
  dailyCap: string;
  approvalThreshold: string;
}
export type PresetId = "careful" | "everyday" | "shopper" | "custom";
export interface LimitPreset {
  id: Exclude<PresetId, "custom">;
  label: string;
  blurb: string;
  limits: Limits;
}

export const LIMIT_PRESETS: LimitPreset[] = [
  { id: "careful", label: "Careful", blurb: "Small API calls only", limits: { maxPerTx: "1.00", dailyCap: "5.00", approvalThreshold: "1.00" } },
  { id: "everyday", label: "Everyday", blurb: "Most tasks", limits: { maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "5.00" } },
  { id: "shopper", label: "Shopper", blurb: "Buys things, asks first", limits: { maxPerTx: "20.00", dailyCap: "50.00", approvalThreshold: "10.00" } },
];
export const DEFAULT_PRESET: LimitPreset["id"] = "everyday";

/** Largest per-payment / daily / ask-above value the sheet accepts. */
export const MAX_LIMIT = "10000.00";

export const presetLimits = (id: LimitPreset["id"]): Limits => ({ ...LIMIT_PRESETS.find((p) => p.id === id)!.limits });

/** Which preset these numbers are, or "custom". */
export function presetOf(l: Limits): PresetId {
  const same = (a: string, b: string) => toCents(a) === toCents(b);
  const p = LIMIT_PRESETS.find((x) => same(x.limits.maxPerTx, l.maxPerTx) && same(x.limits.dailyCap, l.dailyCap) && same(x.limits.approvalThreshold, l.approvalThreshold));
  return p ? p.id : "custom";
}

/** "$1 per payment · $5 a day · ask above $1" */
export function limitsLine(l: Limits): string {
  return `${shortMoney(l.maxPerTx)} per payment · ${shortMoney(l.dailyCap)} a day · ask above ${shortMoney(l.approvalThreshold)}`;
}

/** What these limits mean, in one sentence. Payments strictly above the threshold wait; above maxPerTx are blocked. */
export function limitsMeaning(l: Limits): string {
  const per = shortMoney(l.maxPerTx);
  const day = shortMoney(l.dailyCap);
  const ask = toCents(l.approvalThreshold);
  if (ask <= 0) return `Every payment waits for your OK. Nothing over ${per} a payment or ${day} a day.`;
  if (ask >= toCents(l.maxPerTx)) return `Pays up to ${per} at a time on its own, ${day} a day. Anything bigger is blocked.`;
  return `Pays up to ${shortMoney(l.approvalThreshold)} on its own. Up to ${per} waits for your OK. Never more than ${day} a day.`;
}

export type LimitsCheck = { ok: true; limits: Limits } | { ok: false; errors: Partial<Record<keyof Limits, string>> };

/** Validate the three editable numbers (raw text from the inputs). */
export function checkLimits(raw: Limits): LimitsCheck {
  const per = parseAmount(raw.maxPerTx, { min: "0.01", max: MAX_LIMIT });
  const day = parseAmount(raw.dailyCap, { min: "0.01", max: MAX_LIMIT });
  const ask = parseAmount(raw.approvalThreshold, { min: "0", max: MAX_LIMIT });
  const errors: Partial<Record<keyof Limits, string>> = {};
  if (!per.ok) errors.maxPerTx = per.message;
  if (!day.ok) errors.dailyCap = day.message;
  if (!ask.ok) errors.approvalThreshold = ask.message;
  if (per.ok && day.ok && day.cents < per.cents) errors.dailyCap = "Can't be less than one payment.";
  if (per.ok && day.ok && ask.ok && !Object.keys(errors).length) {
    return { ok: true, limits: { maxPerTx: per.amount, dailyCap: day.amount, approvalThreshold: ask.amount } };
  }
  return { ok: false, errors };
}

/**
 * The policy for a new agent. Allowlist empty on purpose: connected services govern what it may
 * pay (§13.2, §14.3).
 */
export function policyFromLimits(l: Limits): Pick<Policy, "maxPerTx" | "dailyCap" | "approvalThreshold" | "allowlist"> {
  return { maxPerTx: l.maxPerTx, dailyCap: l.dailyCap, approvalThreshold: l.approvalThreshold, allowlist: { addresses: [], origins: [] } };
}

/** The `POST /v1/agents` body. Zero starting money (or chain mode) sends no `initialBalance`. */
export function createAgentBody(input: { name: string; limits: Limits; initialBalance?: string; services: string[] }): CreateAgentRequest {
  const services = [...new Set(input.services.filter((s) => s && s !== "directory"))];
  const body: CreateAgentRequest = { name: input.name, policy: policyFromLimits(input.limits), services };
  if (input.initialBalance && toCents(input.initialBalance) > 0) body.initialBalance = input.initialBalance;
  return body;
}

// ---------------------------------------------------------------------------- embed messages (§14.3)

export interface SheetSizeMessage {
  type: "allowance:sheet-size";
  sheet: SheetId;
  height: number;
}
export interface AgentCreatedMessage {
  type: "allowance:agent-created";
  name: string;
}
export interface MoneyAddedMessage {
  type: "allowance:money-added";
  name: string;
  amount: string;
}
export interface SheetCloseMessage {
  type: "allowance:sheet-close";
  sheet: SheetId;
}
export type SheetMessage = SheetSizeMessage | AgentCreatedMessage | MoneyAddedMessage | SheetCloseMessage;

// Builders take only the fields the contract names, so a token can never ride along.
export const sheetSizeMessage = (sheet: SheetId, height: number): SheetSizeMessage => ({ type: "allowance:sheet-size", sheet, height: Math.ceil(height) });
export const agentCreatedMessage = (name: string): AgentCreatedMessage => ({ type: "allowance:agent-created", name });
export const moneyAddedMessage = (name: string, amount: string): MoneyAddedMessage => ({ type: "allowance:money-added", name, amount });
export const sheetCloseMessage = (sheet: SheetId): SheetCloseMessage => ({ type: "allowance:sheet-close", sheet });

/** Post one sheet message to the parent window, at its real origin if allowed, else the chat's. */
export function postSheetMessage(msg: SheetMessage, chatUrl: string) {
  if (typeof window === "undefined" || !window.parent || window.parent === window) return;
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  const parent = ancestors && ancestors.length ? ancestors[0] : null;
  const target = pickTarget(postTargets(chatUrl, location.origin), chatUrl, [parent, document.referrer]);
  try {
    window.parent.postMessage(msg, target);
  } catch {
    /* a malformed origin never breaks the sheet */
  }
}
