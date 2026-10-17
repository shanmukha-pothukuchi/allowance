import { defineConfig } from "vite";
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

// Only the dashboard itself and the agent chat (§13.5 approval embed) may frame these pages.
// Without this any site could iframe the approve buttons (clickjacking).
const securityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'self' http://localhost:4050 http://127.0.0.1:4050",
};

// The dashboard talks to the wallet-service only, always via relative /v1 URLs.
// In dev, Vite proxies /v1 to the wallet-service; SSE (/v1/events) streams through
// http-proxy unbuffered. In production, put the built files behind the same origin
// as the wallet-service or any reverse proxy that forwards /v1.
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
        // Add the owner key only for requests the dashboard page itself makes. Browsers set
        // Sec-Fetch-Site and page scripts cannot forge it; a server-side fetch (e.g. an agent's
        // fetch_url pointed at :4040) does not send "same-origin", so it gets no owner powers.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            proxyReq.removeHeader("x-owner-key");
            const key = ownerApiKey();
            if (key && req.headers["sec-fetch-site"] === "same-origin") proxyReq.setHeader("x-owner-key", key);
          });
        },
      },
    },
  },
  preview: { port: 4040, strictPort: true, headers: securityHeaders },
});
