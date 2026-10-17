import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard talks to the wallet-service only, always via relative /v1 URLs.
// In dev, Vite proxies /v1 to the wallet-service; SSE (/v1/events) streams through
// http-proxy unbuffered. In production, put the built files behind the same origin
// as the wallet-service or any reverse proxy that forwards /v1.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4040,
    strictPort: true,
    proxy: {
      "/v1": {
        target: process.env.WALLET_SERVICE_URL ?? "http://localhost:4010",
        changeOrigin: true,
      },
    },
  },
  preview: { port: 4040, strictPort: true },
});
