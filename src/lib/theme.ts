/** Color themes (Settings > Appearance). The colors themselves are in globals.css. */
export const THEMES = [
  { id: "light", label: "Light", swatch: ["#ffffff", "#1c1917"] },
  { id: "paper", label: "Paper", swatch: ["#f5efe3", "#2e2820"] },
  { id: "dark", label: "Dark", swatch: ["#1c1b1a", "#e7e5e4"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "flow.theme";

/**
 * Runs in <head> before the page paints, so a reload doesn't flash the light
 * theme first. Plain JS in a string: it can't import anything.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="dark"||t==="paper")document.documentElement.dataset.theme=t}catch(e){}`;

export function currentTheme(): ThemeId {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || t === "paper" ? t : "light";
}

export function setTheme(id: ThemeId) {
  if (id === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {}
}
