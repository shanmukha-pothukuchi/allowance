import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
export const staticDir = STATIC_DIR;

export interface PageConfig {
  model: string;
  endpoint: string;
  llmConfigured: boolean;
  links: { dashboard?: string; board?: string; explorer?: string };
}

/** JSON safe to embed inside <script>: no "</script>", no HTML comment openers. */
function embed(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** Cache-buster so a reload during the demo always picks up the current chat.js / chat.css. */
function version(name: string): string {
  try {
    return Math.floor(statSync(join(STATIC_DIR, name)).mtimeMs).toString(36);
  } catch {
    return "0";
  }
}

// Inline SVG favicon (no network request): a white shield-check on the Allowance green/blue tile.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34c759"/><stop offset="1" stop-color="#0a84ff"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M16 26s7-3.5 7-8.75V10.5L16 8l-7 2.5v6.75C9 22.5 16 26 16 26z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="m12.8 16.6 2.2 2.2 4.2-4.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

// Runs before the stylesheet paints: apply the saved light/dark choice so dark mode never flashes white.
const THEME_BOOT = `try{var t=localStorage.getItem("allowance-chat-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function renderChatPage(cfg: PageConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Allowance Agents</title>
<link rel="icon" href="${FAVICON}">
<script>${THEME_BOOT}</script>
<link rel="stylesheet" href="/static/chat.css?v=${version("chat.css")}">
</head>
<body>
<div id="app"></div>
<script>window.__CHAT__ = ${embed(cfg)};</script>
<script src="/static/chat.js?v=${version("chat.js")}"></script>
</body>
</html>`;
}

export function readStatic(name: "chat.css" | "chat.js"): string {
  return readFileSync(join(STATIC_DIR, name), "utf8");
}
