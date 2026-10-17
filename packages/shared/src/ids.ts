import { randomBytes, createHash } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Agent API token. Format: aw_<24 hex>. Store only its sha256. */
export function newAgentToken(): string {
  return `aw_${randomBytes(24).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Local calendar day key, e.g. "2026-10-17". Daily caps reset when this changes. */
export function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isSameLocalDay(iso: string, now = new Date()): boolean {
  return localDayKey(new Date(iso)) === localDayKey(now);
}
