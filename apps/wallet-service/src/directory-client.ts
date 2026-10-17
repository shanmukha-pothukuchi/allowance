/**
 * Client for the service directory (apps/directory, docs/ARCHITECTURE.md §13.1).
 * 3 s timeout per call; listings are cached for 30 s. Any failure (down, timeout, 5xx, bad JSON)
 * is a `DirectoryUnavailableError`; callers answer 503 or, for policy, fall back without failing open.
 */
import type { ServiceManifest } from "@allowance/shared";

export class DirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryUnavailableError";
  }
}

export interface DirectoryQuery {
  q?: string;
  category?: string;
}

export interface DirectoryClient {
  /** Listing without docs. Throws DirectoryUnavailableError. */
  list(query?: DirectoryQuery): Promise<ServiceManifest[]>;
  /** One manifest with docs, or null if the directory has no such id. Throws DirectoryUnavailableError. */
  get(id: string): Promise<ServiceManifest | null>;
}

export interface HttpDirectoryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
}

export function httpDirectoryClient(directoryUrl: string, opts: HttpDirectoryOptions = {}): DirectoryClient {
  const base = directoryUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const cacheMs = opts.cacheMs ?? 30_000;
  const cache = new Map<string, { at: number; services: ServiceManifest[] }>();

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DirectoryUnavailableError(`directory not reachable at ${base}: ${(err as Error).message}`);
    }
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new DirectoryUnavailableError(`directory answered ${res.status}`);
    try {
      return { status: res.status, body: await res.json() };
    } catch {
      throw new DirectoryUnavailableError("directory sent invalid JSON");
    }
  }

  return {
    async list(query = {}) {
      const params = new URLSearchParams();
      if (query.q) params.set("q", query.q);
      if (query.category) params.set("category", query.category);
      const qs = params.toString();
      const hit = cache.get(qs);
      if (hit && Date.now() - hit.at < cacheMs) return hit.services;
      const { status, body } = await getJson(`/services${qs ? `?${qs}` : ""}`);
      const services = (body as { services?: unknown } | null)?.services;
      if (status !== 200 || !Array.isArray(services)) throw new DirectoryUnavailableError("directory listing was malformed");
      const valid = services.filter(isManifestLike);
      cache.set(qs, { at: Date.now(), services: valid });
      if (cache.size > 100) cache.delete(cache.keys().next().value!);
      return valid;
    },
    async get(id) {
      const { status, body } = await getJson(`/services/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (!isManifestLike(body) || body.id !== id) throw new DirectoryUnavailableError("directory manifest was malformed");
      return body;
    },
  };
}

function isManifestLike(v: unknown): v is ServiceManifest {
  const s = v as Partial<ServiceManifest> | null;
  return Boolean(
    s &&
      typeof s === "object" &&
      typeof s.id === "string" &&
      typeof s.name === "string" &&
      typeof s.baseUrl === "string" &&
      typeof s.maxPrice === "string" &&
      typeof s.kind === "string",
  );
}
