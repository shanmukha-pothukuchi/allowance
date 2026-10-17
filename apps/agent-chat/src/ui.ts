import { readFileSync } from "node:fs";
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

export function renderChatPage(cfg: PageConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allowance Agents</title>
<link rel="stylesheet" href="/static/chat.css">
</head>
<body>
<div id="app"></div>
<script>window.__CHAT__ = ${embed(cfg)};</script>
<script src="/static/chat.js"></script>
</body>
</html>`;
}

export function readStatic(name: "chat.css" | "chat.js"): string {
  return readFileSync(join(STATIC_DIR, name), "utf8");
}
