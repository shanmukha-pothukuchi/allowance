/**
 * Minimal OpenAI-compatible chat-completions client (plain fetch, no SDK).
 * Works with NRP's managed LLMs (https://ellm.nrp-nautilus.io/v1) and any other compatible server.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  extraBody?: Record<string, unknown>;
  /** Per-attempt timeout. Open-weight models on shared GPUs can be slow; default 120 s. */
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors (NRP asks automated clients to retry with backoff). */
  maxRetries?: number;
  fetch?: typeof fetch;
  /** Base backoff in ms (tests shrink it). */
  backoffMs?: number;
}

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  waitMs: number;
  reason: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function chatCompletion(
  cfg: LlmConfig,
  req: { messages: ChatMessage[]; tools?: ToolDef[]; signal?: AbortSignal; onRetry?: (info: RetryInfo) => void },
): Promise<ChatResult> {
  if (!cfg.apiKey && /nrp-nautilus\.io/.test(cfg.baseUrl)) {
    throw new LlmError("LLM_API_KEY is not set. Get an NRP token at https://nrp.ai/llmtoken/ and put LLM_API_KEY=... in .env, then restart npm run dev.", 401);
  }
  const doFetch = cfg.fetch ?? fetch;
  const maxRetries = cfg.maxRetries ?? 4;
  const backoff = cfg.backoffMs ?? 1000;
  const body = JSON.stringify({
    model: cfg.model,
    messages: req.messages,
    ...(req.tools && req.tools.length ? { tools: req.tools, tool_choice: "auto" } : {}),
    ...(cfg.extraBody ?? {}),
  });

  let lastError: LlmError | undefined;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(lastError?.status === 429 && retryAfterMs > 0 ? retryAfterMs : backoff * 2 ** (attempt - 1), 15_000);
      req.onRetry?.({ attempt, maxRetries, waitMs: wait, reason: lastError?.message ?? "error" });
      await sleep(wait, req.signal);
    }
    retryAfterMs = 0;
    const timeout = AbortSignal.timeout(cfg.timeoutMs ?? 120_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body,
        signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      const timedOut = timeout.aborted;
      lastError = new LlmError(
        timedOut ? `The model did not answer within ${Math.round((cfg.timeoutMs ?? 120_000) / 1000)} s` : `Could not reach the LLM at ${cfg.baseUrl}: ${(err as Error).message}`,
        undefined,
        true,
      );
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
      lastError = new LlmError(describeHttpError(res.status, text, cfg), res.status, RETRYABLE.has(res.status));
      if (!lastError.retryable) throw lastError;
      continue;
    }
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null; tool_calls?: Array<Partial<ToolCall>>; reasoning_content?: string; reasoning?: string };
      }>;
      usage?: ChatResult["usage"];
    };
    const choice = json.choices?.[0];
    if (!choice?.message) throw new LlmError("The model returned no message", res.status);
    const msg = choice.message;
    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((t) => t?.function?.name)
      .map((t, i) => ({
        id: t.id || `call_${Date.now().toString(36)}_${i}`,
        type: "function",
        function: { name: t.function!.name, arguments: t.function!.arguments ?? "{}" },
      }));
    return {
      content: stripThinkTags(msg.content ?? ""),
      toolCalls,
      reasoning: msg.reasoning_content || msg.reasoning || undefined,
      finishReason: choice.finish_reason,
      usage: json.usage,
    };
  }
  throw lastError ?? new LlmError("LLM request failed");
}

function describeHttpError(status: number, text: string, cfg: LlmConfig): string {
  const detail = text.slice(0, 300).replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403) return `The LLM endpoint rejected the API key (HTTP ${status}). Check LLM_API_KEY in .env.`;
  if (status === 404) return `The LLM endpoint does not know model "${cfg.model}" (HTTP 404). Check LLM_MODEL; list models with GET ${cfg.baseUrl}/models. ${detail}`;
  if (status === 429) return `The LLM endpoint is rate limiting us (HTTP 429). ${detail}`;
  return `LLM request failed (HTTP ${status}). ${detail}`;
}

/** Some reasoning models inline <think>…</think> in content; keep it out of the chat. */
function stripThinkTags(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
