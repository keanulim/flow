/** Color themes (Settings > Appearance). The colors themselves are in globals.css. */
export const THEMES = [
  { id: "light", label: "Light", swatch: ["#ffffff", "#1c1917"] },
  { id: "dark", label: "Dark", swatch: ["#1c1b1a", "#e7e5e4"] },
  { id: "neon", label: "Neon", swatch: ["#0a0a12", "#ff4fa3"] },
  { id: "nord", label: "Nord", swatch: ["#2e3440", "#88c0d0"] },
  { id: "mocha", label: "Mocha", swatch: ["#1e1e2e", "#cba6f7"] },
  { id: "rose", label: "Rosé", swatch: ["#faf4ed", "#907aa9"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "flow.theme";

/**
 * Runs in <head> before the page paints, so a reload doesn't flash the light
 * theme first. Plain JS in a string: it can't import anything.
 */
const OTHERS = THEMES.map((t) => t.id).filter((id) => id !== "light"); // light is the default: no data-theme
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(${JSON.stringify(OTHERS)}.indexOf(t)>=0)document.documentElement.dataset.theme=t}catch(e){}`;

export function currentTheme(): ThemeId {
  const t = document.documentElement.dataset.theme;
  return THEMES.find((x) => x.id === t)?.id ?? "light";
}

export function setTheme(id: ThemeId) {
  if (id === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {}
}
