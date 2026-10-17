/**
 * Defense in depth: strip anything that looks like a private key from objects before
 * they are logged, emitted as events, or returned from an API.
 */
const PK_KEYS = /^(privateKey|private_key|secret|mnemonic|seed)$/i;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

export function redact<T>(value: T): T {
  return walk(value, new WeakSet()) as T;
}

function walk(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || typeof v !== "object") {
    // A bare 64-byte hex string that is not inside a known-safe field is suspicious;
    // we leave it (tx hashes and nonces are also 32 bytes) and rely on key-name redaction.
    return v;
  }
  if (seen.has(v as object)) return "[circular]";
  seen.add(v as object);
  if (Array.isArray(v)) return v.map((x) => walk(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (PK_KEYS.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = walk(val, seen);
    }
  }
  return out;
}

/** True if the string contains something that looks like one of the given private keys. */
export function containsSecret(haystack: string, secrets: string[]): boolean {
  const h = haystack.toLowerCase();
  return secrets.some((s) => s && h.includes(s.toLowerCase().replace(/^0x/, "")));
}

export { HEX64 };
