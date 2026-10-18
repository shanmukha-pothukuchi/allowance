/**
 * Scheduler tools (ARCHITECTURE §20.3): an agent sets reminders and price watches for itself, so it
 * can be woken later without its owner typing anything. The scheduler (apps/scheduler, default
 * http://localhost:4100, `SCHEDULER_URL`) checks the agent token with the wallet; it fires by
 * messaging the agent's chat, so schedules only fire for agents the Allowance chat hosts. Firing
 * never spends anything: the woken agent acts through these same tools and the wallet's policy.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { FetchLike } from "./wallet-client.js";

export const DEFAULT_SCHEDULER_URL = "http://localhost:4100";

export interface ScheduleToolOptions {
  agentToken: string;
  /** Default: SCHEDULER_URL from the environment, else http://localhost:4100. */
  schedulerUrl?: string;
  fetch?: FetchLike;
  log?: (msg: string) => void;
  /** Clock for "in 5 minutes" (tests). */
  now?: () => number;
}

/** The fields of a scheduler schedule these tools read (GET /schedules). */
interface ScheduleView {
  id: string;
  kind: "at" | "every" | "price";
  at?: string;
  everyMinutes?: number;
  condition?: { ticker?: string; op?: ">=" | "<="; price?: number; movePct?: number; basePrice?: number; portfolio?: string; value?: number };
  checkEverySeconds?: number;
  message: string;
  source: "agent" | "owner";
  rule?: string;
  nextRunAt?: string;
  lastObserved?: string;
  active: boolean;
  needsChat?: boolean;
  summary: string;
  lastError?: string;
}

class SchedulerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class SchedulerUnreachableError extends Error {}

const money = (n: number) => `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function utcTime(iso: string, now: number): string {
  const d = new Date(iso);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  return d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? hm : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${hm}`;
}

function inWords(iso: string, now: number): string {
  const min = Math.round((Date.parse(iso) - now) / 60_000);
  if (min < 1) return "in under a minute";
  if (min < 90) return `in ${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  return h < 36 ? `in ${h} hours` : `in ${Math.round(h / 24)} days`;
}

function every(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

/** "it is at or above $210", "it is up 5% from $201.30". */
function untilWords(c: NonNullable<ScheduleView["condition"]>): string {
  if (c.movePct !== undefined) return `it is ${c.movePct < 0 ? "down" : "up"} ${Math.abs(c.movePct)}%${c.basePrice ? ` from ${price(c.basePrice)}` : ""}`;
  return `it is at or ${c.op === "<=" ? "below" : "above"} ${money(c.price ?? 0)}`;
}

const NEEDS_CHAT =
  " Note: you aren't running in the Allowance chat (for example, you're in Claude Desktop), so nothing can wake you: the schedule is saved and your owner sees it, but schedules only fire for agents hosted by the Allowance chat.";
const PAUSED = " Your owner has paused all schedules right now, so it won't fire until they resume.";

/** The confirmation the agent reads back (and may pass on to its owner). */
export function confirmText(s: ScheduleView, now: number, flags: { paused?: boolean; needsChat?: boolean } = {}): string {
  let main: string;
  if (s.kind === "at") main = `Reminder set: I'll wake you at ${utcTime(s.at!, now)} (${inWords(s.at!, now)}) with "${s.message}" (fires once).`;
  else if (s.kind === "every") main = `Reminder set: I'll wake you every ${every(s.everyMinutes ?? 1)} with "${s.message}", first at ${utcTime(s.nextRunAt ?? s.at!, now)}, until it is cancelled.`;
  else {
    const c = s.condition ?? {};
    const check = `${c.ticker}'s paper-trading price every ${s.checkEverySeconds ?? 10} seconds`;
    main = s.everyMinutes
      ? `Reminder set: I'll check ${check} and wake you whenever ${untilWords(c)}, at most once every ${every(s.everyMinutes)}, until it is cancelled.`
      : `Reminder set: I'll check ${check} until ${untilWords(c)} (fires once).`;
  }
  return `${main} Your owner can see and cancel it. Schedule id: ${s.id}.${flags.paused ? PAUSED : ""}${flags.needsChat || s.needsChat ? NEEDS_CHAT : ""}`;
}

/** One line per schedule for list_schedules. */
export function listLine(s: ScheduleView, now: number): string {
  if (s.source === "owner") return `- ${s.id} · Your owner's rule: ${s.summary.replace(/^Rule: /, "")} · only your owner can remove it`;
  const when = s.kind === "at" && s.at ? ` (${inWords(s.at, now)})` : "";
  const seen = s.kind === "price" && s.lastObserved ? ` · last check ${s.lastObserved}` : "";
  const problem = s.lastError ? ` · ${s.lastError}` : "";
  return `- ${s.id} · ${s.summary}${when}${seen}${problem} · "${s.message}"`;
}

export function registerScheduleTools(server: McpServer, opts: ScheduleToolOptions): void {
  const base = (opts.schedulerUrl ?? process.env.SCHEDULER_URL ?? DEFAULT_SCHEDULER_URL).trim().replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? ((m: string) => console.error(`[mcp] ${m}`));
  const now = opts.now ?? Date.now;

  const text = (s: string, structured?: Record<string, unknown>): CallToolResult =>
    structured ? { content: [{ type: "text", text: s }], structuredContent: structured } : { content: [{ type: "text", text: s }] };
  const errorResult = (s: string, structured?: Record<string, unknown>): CallToolResult => ({ ...text(s, structured), isError: true });

  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.agentToken}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SchedulerUnreachableError();
    }
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new SchedulerApiError(res.status, j.error ?? "error", j.message ?? `The scheduler answered ${res.status}`);
    return j as T;
  }

  async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SchedulerUnreachableError) return errorResult(`The scheduler isn't running at ${base}, so reminders can't be set or read right now. Start it with \`npm run dev\`.`);
      if (err instanceof SchedulerApiError) {
        if (err.status === 401) return errorResult(`The scheduler didn't accept this agent's token (${err.code}): ${err.message}. The owner may have revoked it.`);
        return errorResult(err.message, { error: err.code });
      }
      return errorResult(`Error: ${(err as Error).message}`);
    }
  }

  server.registerTool(
    "schedule_task",
    {
      title: "Set a reminder or a price watch",
      description:
        "Set a reminder for yourself, or a watch on a paper-trading price, so you wake up later without your owner typing anything. " +
        "When it fires you get a message marked [Scheduled message] with your note and the facts (the time, or the price and replay date). " +
        "Firing never spends anything by itself: you act with your tools under your owner's policy as usual. " +
        "Give exactly one of: in_minutes or at (once), every_minutes (repeats), or when (a price watch; add every_minutes to keep watching). " +
        "Limits: 10 active schedules, every_minutes at least 1, 30 wake-ups a day. Your owner can see and cancel every schedule, and can pause them all.",
      inputSchema: {
        message: z.string().describe("What to tell yourself when it fires, as an instruction, e.g. \"Check COF and tell your owner if it is still above $210.\" At most 500 characters."),
        in_minutes: z.number().optional().describe("Fire once, this many minutes from now (e.g. 1, 30, 1440). Prefer this to at: you may not know the current time."),
        at: z.string().optional().describe("Fire once at this ISO 8601 time, e.g. 2026-10-18T18:05:00Z. With every_minutes: the first run."),
        every_minutes: z.number().optional().describe("Repeat every N minutes (at least 1) until cancelled. With when: wake at most once every N minutes while the condition holds, instead of once."),
        when: z
          .object({
            ticker: z.string().describe("Ticker on the paper brokerage, e.g. COF."),
            above: z.number().optional().describe("Fire when the price is at or above this, in dollars."),
            below: z.number().optional().describe("Fire when the price is at or below this, in dollars."),
            move_pct: z.number().optional().describe("Fire when the price moves this many percent from now: 5 = up 5%, -5 = down 5%."),
          })
          .optional()
          .describe("A price watch, checked every 10 seconds against the paper brokerage (replay of real closes). Give one of above, below or move_pct."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const body: Record<string, unknown> = { message: args.message };
        if (args.in_minutes !== undefined && args.at !== undefined) return errorResult("Give in_minutes or at, not both.");
        if (args.when) {
          const w = args.when;
          const given = [w.above, w.below, w.move_pct].filter((v) => v !== undefined).length;
          if (given !== 1) return errorResult('For a price watch give exactly one of above, below or move_pct, e.g. when: { ticker: "COF", above: 210 }.');
          if (args.in_minutes !== undefined || args.at !== undefined) return errorResult("A price watch starts now: leave out in_minutes and at.");
          body.condition = w.above !== undefined ? { ticker: w.ticker, op: ">=", price: w.above } : w.below !== undefined ? { ticker: w.ticker, op: "<=", price: w.below } : { ticker: w.ticker, movePct: w.move_pct };
          if (args.every_minutes !== undefined) body.everyMinutes = args.every_minutes;
        } else if (args.every_minutes !== undefined) {
          body.everyMinutes = args.every_minutes;
          if (args.at !== undefined) body.at = args.at;
          if (args.in_minutes !== undefined) body.at = new Date(now() + args.in_minutes * 60_000).toISOString();
        } else if (args.in_minutes !== undefined) body.inMinutes = args.in_minutes;
        else if (args.at !== undefined) body.at = args.at;
        else return errorResult("Say when: in_minutes (or at) for a one-off reminder, every_minutes to repeat, or when for a price watch.");

        const r = await call<{ schedule: ScheduleView; needsChat: boolean; paused: boolean }>("POST", "/schedules", body);
        log(`schedule_task set ${r.schedule.id}: ${r.schedule.summary}`);
        return text(confirmText(r.schedule, now(), { paused: r.paused, needsChat: r.needsChat }), { schedule: r.schedule, needsChat: r.needsChat, paused: r.paused });
      }),
  );

  server.registerTool(
    "list_schedules",
    {
      title: "List your reminders and watches",
      description: "List your active reminders and price watches, and any rules your owner set for you (take profit, stop loss, cash out), with their ids and when they fire next.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const r = await call<{ schedules: ScheduleView[]; paused: boolean; firingsToday: number; limits?: { maxFiringsPerDay?: number } }>("GET", "/schedules");
        const t = now();
        const lines: string[] = [];
        if (r.schedules.length === 0) lines.push("You have no active schedules. schedule_task sets a reminder or a price watch.");
        else {
          lines.push(`Your schedules (${r.schedules.length} active). Your owner can see and cancel all of them:`);
          // its own reminders first, then its owner's rules
          for (const s of [...r.schedules.filter((x) => x.source !== "owner"), ...r.schedules.filter((x) => x.source === "owner")]) lines.push(listLine(s, t));
          lines.push(`Woken ${r.firingsToday} of ${r.limits?.maxFiringsPerDay ?? 30} times today.`);
        }
        if (r.paused) lines.push("Your owner has paused all schedules: nothing fires until they resume.");
        if (r.schedules.some((s) => s.needsChat)) lines.push("Note: you aren't running in the Allowance chat, so these can't wake you; schedules only fire for agents hosted by the Allowance chat.");
        return text(lines.join("\n"), { schedules: r.schedules, paused: r.paused, firingsToday: r.firingsToday });
      }),
  );

  server.registerTool(
    "cancel_schedule",
    {
      title: "Cancel a reminder or watch",
      description: "Cancel one of your reminders or price watches by its id (sch_…, from schedule_task or list_schedules). Your owner's rules can only be removed by your owner.",
      inputSchema: { id: z.string().describe("The schedule id, e.g. sch_0123456789abcdef.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const id = args.id.trim();
        if (!/^sch_[A-Za-z0-9]{1,64}$/.test(id)) return errorResult(`"${args.id}" isn't a schedule id. They look like sch_0123456789abcdef; list_schedules shows yours.`);
        try {
          const r = await call<{ schedule: ScheduleView }>("DELETE", `/schedules/${encodeURIComponent(id)}`);
          log(`cancel_schedule ${id}`);
          return text(`Cancelled ${id} (${r.schedule.summary.replace(/ · cancelled$/, "")}). It won't fire.`, { schedule: r.schedule });
        } catch (err) {
          if (err instanceof SchedulerApiError && err.status === 404) return errorResult(`There is no schedule ${id} of yours. list_schedules shows them.`, { error: err.code });
          throw err;
        }
      }),
  );
}
