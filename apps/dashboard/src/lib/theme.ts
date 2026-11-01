import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const STORAGE_KEY = "workmesh-theme";

function read(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system"; // storage can be unavailable (private window, blocked site data)
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** The colour theme: follows the operating system unless the person chose one. */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => apply(theme), [theme]);
  const choose = useCallback((next: Theme) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the choice still applies for this visit */
    }
    setTheme(next);
  }, []);
  return [theme, choose];
}

/** Applies the saved theme before the first paint, so there is no flash of the wrong colours. */
export function initTheme(): void {
  apply(read());
}
