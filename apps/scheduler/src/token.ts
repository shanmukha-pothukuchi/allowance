import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

/**
 * The internal token the scheduler sends to the chat server as X-Scheduler-Token, so only the
 * scheduler can post `source: "scheduler"` messages. `DATA_DIR/scheduler-token.json`, mode 0600.
 * Agents never see it: the chat server and the scheduler read it from disk.
 */
export function schedulerTokenPath(dataDir: string): string {
  return resolve(dataDir, "scheduler-token.json");
}

export function readSchedulerToken(dataDir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(schedulerTokenPath(dataDir), "utf8")) as { schedulerToken?: string };
    return typeof j.schedulerToken === "string" && j.schedulerToken ? j.schedulerToken : undefined;
  } catch {
    return undefined;
  }
}

/** Create the token file on first start (same race-safe pattern as ensureOwnerKey); returns the token. */
export function ensureSchedulerToken(dataDir: string): string {
  const existing = readSchedulerToken(dataDir);
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true });
  const schedulerToken = `st_${randomBytes(24).toString("hex")}`;
  try {
    // "wx": fail if another process created it first, then use theirs.
    writeFileSync(schedulerTokenPath(dataDir), JSON.stringify({ schedulerToken }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return schedulerToken;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    for (let i = 0; i < 20; i++) {
      const theirs = readSchedulerToken(dataDir);
      if (theirs) return theirs;
      // The other writer may still be mid-write; wait briefly (synchronously) and re-read.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    throw new Error("scheduler-token.json exists but could not be read");
  }
}
