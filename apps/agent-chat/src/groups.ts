/**
 * Broadcast groups (like WhatsApp broadcast lists): a named set of agents the owner messages at once.
 * Groups carry no money authority, so the chat server owns them. Persisted as JSON.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface GroupDef {
  id: string;
  name: string;
  emoji: string;
  color: string;
  members: string[];
  createdAt: string;
  /** The default "All workers" group; can be edited but not deleted. */
  builtIn?: boolean;
}

const COLORS = ["#5B7CFA", "#E5527A", "#2BB3A3", "#F08A24", "#9B5BFA", "#2F9E5B", "#D9488F", "#3AA0E0"];
const MAX_NAME = 40;

export class GroupStore {
  private groups: GroupDef[] = [];

  constructor(
    private readonly file: string | undefined,
    seed: () => GroupDef[],
  ) {
    if (file && existsSync(file)) {
      try {
        this.groups = (JSON.parse(readFileSync(file, "utf8")) as { groups: GroupDef[] }).groups ?? [];
      } catch {
        this.groups = [];
      }
    }
    if (this.groups.length === 0) {
      this.groups = seed();
      this.save();
    }
  }

  list(): GroupDef[] {
    return this.groups.map((g) => ({ ...g, members: [...g.members] }));
  }

  get(id: string): GroupDef | undefined {
    return this.groups.find((g) => g.id === id);
  }

  create(input: { name: unknown; members: unknown; emoji?: unknown }, known: Set<string>): GroupDef {
    const name = cleanName(input.name);
    const members = cleanMembers(input.members, known);
    let id = slug(name) || "group";
    if (this.get(id) || id === "all") id = `${id}-${this.groups.length + 1}`;
    const g: GroupDef = {
      id,
      name,
      emoji: cleanEmoji(input.emoji) ?? "📣",
      color: COLORS[this.groups.length % COLORS.length],
      members,
      createdAt: new Date().toISOString(),
    };
    this.groups.push(g);
    this.save();
    return g;
  }

  update(id: string, patch: { name?: unknown; members?: unknown; emoji?: unknown }, known: Set<string>): GroupDef {
    const g = this.get(id);
    if (!g) throw new GroupError(404, "group_not_found", `No group ${id}`);
    if (patch.name !== undefined) g.name = cleanName(patch.name);
    if (patch.members !== undefined) g.members = cleanMembers(patch.members, known);
    if (patch.emoji !== undefined) g.emoji = cleanEmoji(patch.emoji) ?? g.emoji;
    this.save();
    return g;
  }

  remove(id: string): void {
    const g = this.get(id);
    if (!g) throw new GroupError(404, "group_not_found", `No group ${id}`);
    if (g.builtIn) throw new GroupError(409, "group_built_in", `"${g.name}" is the default group; edit its members instead`);
    this.groups = this.groups.filter((x) => x.id !== id);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ groups: this.groups }, null, 2));
    renameSync(tmp, this.file);
  }
}

export class GroupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) throw new GroupError(400, "invalid_request", "A group needs a name");
  if (s.length > MAX_NAME) throw new GroupError(400, "invalid_request", `Group names are at most ${MAX_NAME} characters`);
  return s;
}

function cleanMembers(v: unknown, known: Set<string>): string[] {
  if (!Array.isArray(v)) throw new GroupError(400, "invalid_request", "`members` must be a list of agent names");
  const out = [...new Set(v.filter((x): x is string => typeof x === "string"))];
  const unknown = out.filter((n) => !known.has(n));
  if (unknown.length) throw new GroupError(400, "invalid_request", `Unknown agents: ${unknown.join(", ")}`);
  if (out.length === 0) throw new GroupError(400, "invalid_request", "A group needs at least one agent");
  return out;
}

/** One emoji-ish token, at most 8 code units; anything else falls back to the default. */
function cleanEmoji(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > 8 || /[<>&"'`\s]/.test(s)) return undefined;
  return s;
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function defaultGroups(agentNames: string[]): GroupDef[] {
  const workers = agentNames.filter((n) => /^worker-\d+$/.test(n));
  if (workers.length === 0) return [];
  return [{ id: "workers", name: "All workers", emoji: "🛠️", color: "#5B7CFA", members: workers, createdAt: new Date().toISOString(), builtIn: true }];
}
