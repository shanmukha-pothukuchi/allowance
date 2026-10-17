/** Theme: dark by default, light when the OS prefers it, and an explicit override (toggle / ?theme=). */
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
  if (t !== "system") return t;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
