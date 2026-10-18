import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
export const staticDir = STATIC_DIR;
/** Google Sans (OFL), bundled from @fontsource so the page needs no font CDN. */
export const fontsDir = join(dirname(createRequire(import.meta.url).resolve("@fontsource/google-sans/package.json")), "files");

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

// Inline SVG favicon (no network request): a white shield-check on a near-black tile.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f1f22"/><path d="M16 26s7-3.5 7-8.75V10.5L16 8l-7 2.5v6.75C9 22.5 16 26 16 26z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="m12.8 16.6 2.2 2.2 4.2-4.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

// Runs before the stylesheet paints: apply the saved light/dark choice so dark mode never flashes white.
const THEME_BOOT = `try{var t=localStorage.getItem("allowance-chat-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function renderChatPage(cfg: PageConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Allowance Agents</title>
<link rel="icon" href="${FAVICON}">
<script>${THEME_BOOT}</script>
<link rel="preload" href="/static/fonts/google-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/static/fonts/google-sans-latin-500-normal.woff2" as="font" type="font/woff2" crossorigin>
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
