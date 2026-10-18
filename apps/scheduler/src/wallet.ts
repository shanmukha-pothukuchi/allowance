import { hashToken } from "@allowance/shared";
import type { FetchLike } from "./market.js";

export interface AgentIdentity {
  id: string;
  name: string;
  address: string;
}

export class WalletUnavailableError extends Error {
  constructor(message = "The wallet service is not reachable") {
    super(message);
    this.name = "WalletUnavailableError";
  }
}

export interface WalletAuth {
  /** Who holds this agent token (GET /v1/me). null when the wallet rejects it. */
  me(token: string): Promise<AgentIdentity | null>;
  /** Owner lookup by name (GET /v1/agents with the owner key). null when there is no such agent. */
  agentByName(name: string): Promise<AgentIdentity | null>;
}

export interface HttpWalletOptions {
  walletServiceUrl: string;
  ownerApiKey?: string;
  fetch?: FetchLike;
  /** How long a verified token is trusted before asking the wallet again (revocation lag). */
  cacheMs?: number;
  now?: () => number;
}

/** Verifies agent tokens with the wallet. Only sha256(token) is kept in the cache. */
export function httpWallet(opts: HttpWalletOptions): WalletAuth {
  const base = opts.walletServiceUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheMs ?? 30_000;
  const cache = new Map<string, { who: AgentIdentity; until: number }>();

  const identity = (a: unknown): AgentIdentity | null => {
    if (!a || typeof a !== "object") return null;
    const o = a as Record<string, unknown>;
    return typeof o.name === "string" && typeof o.id === "string" ? { id: o.id, name: o.name, address: typeof o.address === "string" ? o.address : "" } : null;
  };

  return {
    async me(token) {
      const key = hashToken(token);
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.who;
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      } catch {
        throw new WalletUnavailableError();
      }
      if (res.status === 401 || res.status === 403) {
        cache.delete(key);
        return null;
      }
      if (!res.ok) throw new WalletUnavailableError(`The wallet service answered ${res.status}`);
      const who = identity(((await res.json().catch(() => null)) as { agent?: unknown } | null)?.agent);
      if (!who) throw new WalletUnavailableError("The wallet service sent an unreadable answer");
      if (cache.size > 500) cache.clear();
      cache.set(key, { who, until: now() + ttl });
      return who;
    },
    async agentByName(name) {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/agents`, { headers: { accept: "application/json", ...(opts.ownerApiKey ? { "x-owner-key": opts.ownerApiKey } : {}) }, signal: AbortSignal.timeout(4000) });
      } catch {
        throw new WalletUnavailableError();
      }
      if (!res.ok) throw new WalletUnavailableError(`The wallet service answered ${res.status}`);
      const j = (await res.json().catch(() => null)) as { agents?: unknown[] } | null;
      for (const a of Array.isArray(j?.agents) ? j.agents : []) {
        const who = identity(a);
        if (who?.name === name) return who;
      }
      return null;
    },
  };
}
