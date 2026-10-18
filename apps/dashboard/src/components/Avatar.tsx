/** Agent avatars (shared face + color per agent) and service icon tiles. */
import { avatarFor, initialsFor } from "@allowance/shared/avatars";
import type { CSSProperties, ReactNode } from "react";

type Size = "xs" | "sm" | "md" | "lg" | "xl";
const tileStyle = (color: string) => ({ "--tile": color }) as CSSProperties;

export function AgentAvatar({ name, size = "md", badge, title }: { name: string; size?: Size; badge?: ReactNode; title?: string }) {
  const a = avatarFor(name);
  return (
    <span className={`avatar avatar-${size}`} style={tileStyle(a.color)} title={title ?? name} role="img" aria-label={name}>
      <span className="avatar-face" aria-hidden>{initialsFor(name)}</span>
      {badge && <span className="avatar-badge">{badge}</span>}
    </span>
  );
}

/** A service's tile: the first letter of its name on a soft tint of its color. */
export function ServiceTile({ name, color, size = "md", title }: { name?: string; color?: string; size?: Size; title?: string }) {
  const letter = (name ?? title ?? "").replace(/^Acme\s+/, "").charAt(0).toUpperCase() || "?";
  return (
    <span className={`svc-tile svc-tile-${size}`} style={tileStyle(color || "#5B7CFA")} title={title} role={title ? "img" : undefined} aria-label={title}>
      <span aria-hidden>{letter}</span>
    </span>
  );
}

/** Small overlapping avatars, "+3" past `max`. */
export function AvatarStack({ names, max = 5 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="avatar-stack" title={names.join(", ")}>
      {shown.map((n) => (
        <AgentAvatar key={n} name={n} size="xs" />
      ))}
      {extra > 0 && <span className="avatar avatar-xs avatar-more">+{extra}</span>}
    </span>
  );
}

export function roleLabel(name: string): string {
  return avatarFor(name).label;
}
