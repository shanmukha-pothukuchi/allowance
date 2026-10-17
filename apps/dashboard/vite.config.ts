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

// The dashboard talks to the wallet-service only, always via relative /v1 URLs.
// In dev, Vite proxies /v1 to the wallet-service; SSE (/v1/events) streams through
// http-proxy unbuffered. In production, put the built files behind the same origin
// as the wallet-service or any reverse proxy that forwards /v1.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4040,
    strictPort: true,
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
        headers: ownerApiKey() ? { "x-owner-key": ownerApiKey()! } : {},
      },
    },
  },
  preview: { port: 4040, strictPort: true },
});
