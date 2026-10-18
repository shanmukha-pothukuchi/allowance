/** Theme: dark by default (like the agent chat), light as an explicit choice (toggle / ?theme=). */
export type ThemePref = "dark" | "light" | "system";
const KEY = "allowance.theme";

export function themeFromSearch(search: string): ThemePref | undefined {
  const t = new URLSearchParams(search).get("theme");
  return t === "dark" || t === "light" || t === "system" ? t : undefined;
}

export function storedTheme(): ThemePref | undefined {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : undefined;
  } catch {
    return undefined;
  }
}

export function saveTheme(t: ThemePref) {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: the toggle still works for this page */
  }
}

export function applyTheme(t: ThemePref) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

/** What is actually on screen right now. */
export function effectiveTheme(t: ThemePref): "dark" | "light" {
  return t === "light" ? "light" : "dark";
}
