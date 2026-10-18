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
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f1f22"/><g transform="translate(5 5) scale(.9167)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></g></svg>',
  );

// Runs before the stylesheet paints: apply the saved light/dark choice so dark mode never flashes white.
const THEME_BOOT = `try{var t=localStorage.getItem("allowance-chat-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function renderChatPage(cfg: PageConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
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
