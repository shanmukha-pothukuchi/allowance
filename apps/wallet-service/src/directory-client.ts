/**
 * Client for the service directory (apps/directory, docs/ARCHITECTURE.md §13.1, §15.2).
 * 3 s timeout per read; listings are cached for 30 s (cleared whenever this client adds a store, so a
 * new store is never hidden). Any read failure (down, timeout, 5xx, bad JSON) is a
 * `DirectoryUnavailableError`; callers answer 503 or, for policy, fall back without failing open.
 */
import type { ServiceManifest } from "@allowance/shared";

export class DirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryUnavailableError";
  }
}

/** The directory refused a write (4xx, or its own 502/503 about the Shopify bridge): status and code pass through. */
export class DirectoryRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** store_unsupported only: why the Shopify store can't be added. */
    public reason?: string,
  ) {
    super(message);
    this.name = "DirectoryRequestError";
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
  /**
   * Owner: add a Shopify store (directory `POST /services/shopify`, owner key). `created: false` when
   * the directory already had it (409 service_exists). Throws DirectoryRequestError / DirectoryUnavailableError.
   * Clears the listing cache either way.
   */
  addShopify(input: { url: string; maxPrice?: string }): Promise<{ service: ServiceManifest; created: boolean }>;
  /** Forget cached listings (after anything changed the directory). */
  invalidate(): void;
}

export interface HttpDirectoryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
  /** Sent as X-Owner-Key on owner writes. */
  ownerApiKey?: string;
  /** Timeout for adding a store (the directory waits on the Shopify bridge). Default 25 s. */
  writeTimeoutMs?: number;
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
    async addShopify(input) {
      let res: Response;
      try {
        res = await doFetch(`${base}/services/shopify`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...(opts.ownerApiKey ? { "x-owner-key": opts.ownerApiKey } : {}) },
          body: JSON.stringify(input.maxPrice === undefined ? { url: input.url } : { url: input.url, maxPrice: input.maxPrice }),
          signal: AbortSignal.timeout(opts.writeTimeoutMs ?? 25_000),
        });
      } catch (err) {
        throw new DirectoryUnavailableError(`directory not reachable at ${base}: ${(err as Error).message}`);
      } finally {
        cache.clear();
      }
      type WriteBody = { service?: unknown; error?: unknown; message?: unknown; reason?: unknown } | null;
      let body: WriteBody = null;
      try {
        body = (await res.json()) as WriteBody;
      } catch {
        body = null;
      }
      if ((res.status === 201 || res.status === 200 || res.status === 409) && isManifestLike(body?.service)) {
        return { service: body!.service as ServiceManifest, created: res.status !== 409 };
      }
      if (res.status === 409 || (res.status >= 400 && res.status < 500) || res.status === 502 || res.status === 503) {
        const code = typeof body?.error === "string" ? body.error.slice(0, 60) : `http_${res.status}`;
        const message = typeof body?.message === "string" ? body.message.slice(0, 300) : `The directory answered ${res.status}`;
        // A 401 here is a wallet/directory key mismatch, not the caller's fault.
        if (res.status === 401) throw new DirectoryRequestError(502, "directory_refused", "The directory refused the owner key; check OWNER_API_KEY matches");
        const reason = typeof body?.reason === "string" && /^[a-z_]{1,40}$/.test(body.reason) ? body.reason : undefined;
        throw new DirectoryRequestError(res.status, code, message, reason);
      }
      throw new DirectoryUnavailableError(`directory answered ${res.status}`);
    },
    invalidate() {
      cache.clear();
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
