/**
 * Test double for Quantcomm's API, on port 0, serving responses recorded from the real instance
 * (fixtures/quantcomm.json, quantcomm fa347bc). Not a test file. It routes like Quantcomm: research
 * for an unknown ticker, or for a panel the company doesn't offer, answers 404 with Quantcomm's
 * `{ success: false, data: null, error: "Unknown research: …" }`. Tests change shapes through `data`.
 */
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  markets: any;
  advice: any;
  research: Record<string, any>;
}

export function recorded(): Recorded {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/quantcomm.json", import.meta.url), "utf8")) as Recorded & { _recorded: string };
  return { markets: raw.markets, advice: raw.advice, research: raw.research };
}

export interface StubQuantcomm {
  url: string;
  /** Every request Quantcomm received: method and path with query. */
  requests: { method: string; path: string }[];
  /** The responses served (fresh copies of the recordings after `reset()`); tests mutate them. */
  data: Recorded;
  /** "down": drop every connection (Quantcomm not running). A number: answer every request with that status. */
  fail?: "down" | number;
  reset(): void;
  count(path: string): number;
  close(): Promise<void>;
}

const unknown = (res: express.Response, what: string) => res.status(404).json({ success: false, data: null, error: `Unknown research: ${what}` });

export async function startStubQuantcomm(): Promise<StubQuantcomm> {
  const app = express();
  const stub = { requests: [], data: recorded() } as unknown as StubQuantcomm;

  app.use((req, res, next) => {
    stub.requests.push({ method: req.method, path: req.originalUrl });
    if (stub.fail === "down") return void req.socket.destroy();
    if (typeof stub.fail === "number") return void res.status(stub.fail).json({ success: false, data: null, error: "Could not build research from the cached pipeline outputs (KeyError)." });
    if (req.method !== "GET") return void res.status(405).json({ success: false, data: null, error: "Method Not Allowed" });
    next();
  });
  app.get("/api/markets", (_req, res) => void res.json(stub.data.markets));
  app.get("/api/advice", (_req, res) => void res.json(stub.data.advice));
  app.get("/api/research/:ticker", (req, res) => {
    const ticker = String(req.params.ticker);
    const r = stub.data.research[ticker];
    if (!r) return void unknown(res, ticker);
    const keys = String(req.query.panels ?? "").split(",").filter(Boolean);
    const offered: string[] = (r.data?.options ?? []).map((o: { key: string }) => o.key);
    const wanted = keys.length ? keys : offered;
    const bad = wanted.filter((k) => !offered.includes(k));
    if (bad.length) return void unknown(res, `${ticker} research panel ${bad.join(", ")}`);
    // Without ?panels= the recording is served as it is (it was recorded that way).
    if (!keys.length) return void res.json(r);
    const absent = keys.filter((k) => !(k in (r.data?.panels ?? {})));
    // Test infrastructure, not Quantcomm behavior: the recording doesn't hold that panel.
    if (absent.length) return void res.status(599).json({ error: `fixture has no ${ticker} panel ${absent.join(", ")}` });
    res.json({ ...r, data: { ...r.data, panels: Object.fromEntries(keys.map((k) => [k, r.data.panels[k]])) } });
  });
  app.use((_req, res) => void res.status(404).json({ success: false, data: null, error: "Not Found" }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.reset = () => {
    stub.data = recorded();
    stub.fail = undefined;
  };
  stub.count = (path: string) => stub.requests.filter((r) => r.path === path).length;
  stub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return stub;
}
