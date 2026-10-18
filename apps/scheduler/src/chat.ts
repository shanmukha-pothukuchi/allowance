import type { FetchLike } from "./market.js";
import type { FireBody } from "./types.js";

export type DeliverResult =
  | { ok: true; runId?: string }
  | { ok: false; reason: "busy" | "not_hosted" | "unreachable" | "rejected" | "error"; message: string };

export interface ChatClient {
  /** POST /api/agents/:name/messages with the scheduler token. */
  deliver(agentName: string, body: FireBody): Promise<DeliverResult>;
  /** Agent names the chat server hosts; null when it can't be asked. */
  hosted(): Promise<Set<string> | null>;
}

export interface HttpChatOptions {
  agentChatUrl: string;
  /** X-Scheduler-Token (DATA_DIR/scheduler-token.json). */
  token: string;
  fetch?: FetchLike;
  /** How long the hosted-agent list is reused. */
  cacheMs?: number;
}

export function httpChat(opts: HttpChatOptions): ChatClient {
  const base = opts.agentChatUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.cacheMs ?? 15_000;
  let roster: { names: Set<string> | null; at: number } = { names: null, at: 0 };

  return {
    async deliver(agentName, body) {
      let res: Response;
      try {
        res = await doFetch(`${base}/api/agents/${encodeURIComponent(agentName)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-scheduler-token": opts.token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return { ok: false, reason: "unreachable", message: "the chat server is not reachable" };
      }
      const j = (await res.json().catch(() => ({}))) as { runId?: string; message?: string };
      if (res.status === 202) return { ok: true, ...(typeof j.runId === "string" ? { runId: j.runId } : {}) };
      if (res.status === 409) return { ok: false, reason: "busy", message: "the agent is busy" };
      if (res.status === 404) {
        roster = { names: null, at: 0 };
        return { ok: false, reason: "not_hosted", message: `the chat server does not host ${agentName}` };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "rejected", message: "the chat server rejected the scheduler token" };
      return { ok: false, reason: "error", message: `the chat server answered ${res.status}${j.message ? `: ${j.message}` : ""}` };
    },
    async hosted() {
      if (roster.names && Date.now() - roster.at < ttl) return roster.names;
      try {
        const res = await doFetch(`${base}/api/agents`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const j = (await res.json()) as { agents?: Array<{ name?: unknown }> };
        const names = new Set((j.agents ?? []).map((a) => a?.name).filter((n): n is string => typeof n === "string"));
        roster = { names, at: Date.now() };
        return names;
      } catch {
        return null;
      }
    },
  };
}
