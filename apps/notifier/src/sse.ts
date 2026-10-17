/**
 * Tiny SSE client over fetch with reconnect + backoff. No dependency.
 */
const LOG = "[notifier]";

export interface SseOptions {
  url: string;
  headers?: Record<string, string>;
  onEvent: (type: string, data: string) => void | Promise<void>;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: (err?: Error) => void | Promise<void>;
  /** Backoff bounds in ms. */
  minDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Parse one SSE block ("event: x\ndata: y") into {type, data}. */
export function parseSseBlock(block: string): { type: string; data: string } | null {
  let type = "message";
  const data: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { type, data: data.join("\n") };
}

export async function subscribeSse(opts: SseOptions): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const min = opts.minDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  let delay = min;
  while (!opts.signal?.aborted) {
    try {
      const res = await doFetch(opts.url, { headers: { accept: "text/event-stream", ...opts.headers }, signal: opts.signal });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      delay = min;
      await opts.onConnect?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseBlock(block);
          if (parsed) await opts.onEvent(parsed.type, parsed.data);
        }
      }
      await opts.onDisconnect?.();
      console.warn(`${LOG} event stream ended; reconnecting`);
    } catch (err) {
      if (opts.signal?.aborted) break;
      await opts.onDisconnect?.(err as Error);
      console.warn(`${LOG} wallet-service unreachable (${(err as Error).message}); retrying in ${delay / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(max, delay * 2);
  }
}
