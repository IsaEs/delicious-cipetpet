import { useEffect } from "react";
import type { ThemeChoice } from "./settings.ts";

/** "system" follows prefers-color-scheme (in CSS); light / dark force it through data-theme on <html> */
export function useTheme(theme: ThemeChoice): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}

export function nextTheme(t: ThemeChoice): ThemeChoice {
  return t === "system" ? "light" : t === "light" ? "dark" : "system";
}
