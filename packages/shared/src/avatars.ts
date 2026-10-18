/**
 * Friendly avatars for agents (pure; safe to import in the browser via "@allowance/shared/avatars").
 * Every UI uses the same face and color for the same agent.
 */
export interface Avatar {
  emoji: string;
  /** Tile background. */
  color: string;
  /** Short role label for list rows. */
  label: string;
}

const KNOWN: Record<string, Avatar> = {
  researcher: { emoji: "🔎", color: "#2BB3A3", label: "Research" },
  shopper: { emoji: "🛍️", color: "#E5527A", label: "Shopping" },
  "flood-analyst": { emoji: "🌊", color: "#1D4ED8", label: "Flood research" },
  trader: { emoji: "💹", color: "#0E9F6E", label: "Paper trading" },
  "web-agent": { emoji: "🖥️", color: "#64748B", label: "Computer use" },
  "claude-desktop": { emoji: "✳️", color: "#D97757", label: "Claude Desktop" },
  "naive-worker": { emoji: "🐣", color: "#E0B13A", label: "Scripted" },
};
const WORKERS = ["#5B7CFA", "#9B5BFA", "#F08A24", "#2F9E5B", "#D9488F", "#3AA0E0"];
const WORKER_EMOJI = ["🦊", "🐙", "🦉", "🐝", "🦦", "🐢"];
const FALLBACK = ["#6E7BF2", "#E36464", "#3BA889", "#C08B2E", "#8E62D9"];
/** Friendly faces for agents the owner creates (picked by name hash; the chat page mirrors this list). */
const FRIENDLY = ["🐼", "🦁", "🐯", "🐨", "🐸", "🐧", "🦄", "🐳", "🦋", "🐞", "🦔", "🦩", "🐬", "🐻", "🦜", "🐿️"];

/** Monogram for an agent's avatar: "researcher" → "R", "worker-3" → "W3", "travel-planner" → "TP". */
export function initialsFor(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  if (!parts.length) return "?";
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^\d+$/.test(last)) return (parts[0][0] + last.slice(0, 2)).toUpperCase();
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function avatarFor(name: string): Avatar {
  if (KNOWN[name]) return KNOWN[name];
  const m = name.match(/^worker-(\d+)$/);
  if (m) {
    const i = (Number(m[1]) - 1 + WORKERS.length) % WORKERS.length;
    return { emoji: WORKER_EMOJI[i], color: WORKERS[i], label: "Worker" };
  }
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { emoji: FRIENDLY[h % FRIENDLY.length], color: FALLBACK[h % FALLBACK.length], label: "Agent" };
}
