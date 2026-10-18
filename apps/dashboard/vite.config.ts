import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Owner endpoints need X-Owner-Key. The dev proxy injects it server-side so the key never ships
// to the browser bundle. Source: OWNER_API_KEY env, else <repo>/.data/owner-key.json (written by
// `npm run setup`).
function ownerApiKey(): string | undefined {
  if (process.env.OWNER_API_KEY) return process.env.OWNER_API_KEY;
  try {
    const file = resolve(__dirname, "../..", process.env.DATA_DIR ?? ".data", "owner-key.json");
    return (JSON.parse(readFileSync(file, "utf8")) as { ownerApiKey?: string }).ownerApiKey;
  } catch {
    return undefined;
  }
}

// Only the dashboard itself and the agent chat (§13.5 approval embed, §14.3 owner sheets) may
// frame these pages. Without this any site could iframe the approve buttons (clickjacking).
// The chat origin follows VITE_AGENT_CHAT_URL (default http://localhost:4050), plus its
// localhost/127.0.0.1 twin, the same origins the sheets post to.
function chatFrameAncestors(): string {
  let u: URL;
  try {
    u = new URL(process.env.VITE_AGENT_CHAT_URL || "http://localhost:4050");
  } catch {
    u = new URL("http://localhost:4050");
  }
  const port = u.port ? `:${u.port}` : "";
  const twin = u.hostname === "localhost" ? `${u.protocol}//127.0.0.1${port}` : u.hostname === "127.0.0.1" ? `${u.protocol}//localhost${port}` : "";
  return [u.origin, twin].filter(Boolean).join(" ");
}
const securityHeaders = {
  "Content-Security-Policy": `frame-ancestors 'self' ${chatFrameAncestors()}`,
};

// Add the owner key only for requests the dashboard page itself makes. Browsers set Sec-Fetch-Site
// and page scripts cannot forge it; a server-side fetch (e.g. an agent's fetch_url pointed at :4040)
// does not send "same-origin", so it gets no owner powers. Every owner route goes through this.
const ownerKeySameOrigin: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyReq", (proxyReq, req) => {
    proxyReq.removeHeader("x-owner-key");
    const key = ownerApiKey();
    if (key && req.headers["sec-fetch-site"] === "same-origin") proxyReq.setHeader("x-owner-key", key);
  });
};

// The dashboard talks to the wallet-service via relative /v1 URLs, and (§20) to the paper brokerage
// via /brokerage and the scheduler via /scheduler. In dev, Vite proxies them; SSE (/v1/events)
// streams through http-proxy unbuffered. In production, put the built files behind the same origin
// as these services or any reverse proxy that forwards the same paths (and adds the owner key the
// same way).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4040,
    strictPort: true,
    headers: securityHeaders,
    // Vite's dev server can serve any workspace file via /@fs/. The repo root holds .data/
    // (owner key, agent private keys), so restrict serving to this app and node_modules only.
    fs: {
      strict: true,
      allow: [resolve(__dirname), resolve(__dirname, "../../node_modules")],
      deny: ["**/.data/**", "**/.env", "**/.env.*", "**/*-key.json", "**/wallet-state.json"],
    },
    proxy: {
      "/v1": {
        target: process.env.WALLET_SERVICE_URL ?? "http://localhost:4010",
        changeOrigin: true,
        configure: ownerKeySameOrigin,
      },
      // §20.1: the brokerage's own paths start with /brokerage.
      "/brokerage": {
        target: process.env.BROKERAGE_URL ?? "http://localhost:4110",
        changeOrigin: true,
        configure: ownerKeySameOrigin,
      },
      // §20.3: the scheduler serves /schedules, /rules, /pause… at its root.
      "/scheduler": {
        target: process.env.SCHEDULER_URL ?? "http://localhost:4100",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/scheduler(?=\/|$)/, "") || "/",
        configure: ownerKeySameOrigin,
      },
    },
  },
  preview: { port: 4040, strictPort: true, headers: securityHeaders },
});
