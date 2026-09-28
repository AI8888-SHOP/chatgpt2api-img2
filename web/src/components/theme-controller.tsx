"use client";

import { useEffect } from "react";

export type ThemeMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "app:theme-mode";
export const THEME_MODES: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function getSystemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getStoredThemeMode(): ThemeMode {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function applyThemeMode(mode: ThemeMode) {
  const resolvedDark = mode === "dark" || (mode === "system" && getSystemDark());
  document.documentElement.classList.toggle("dark", resolvedDark);
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = resolvedDark ? "dark" : "light";
  window.dispatchEvent(new CustomEvent("app:theme-mode", { detail: { mode, resolved: resolvedDark ? "dark" : "light" } }));
}

export function setThemeMode(mode: ThemeMode) {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  applyThemeMode(mode);
}

export function ThemeController() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyThemeMode(getStoredThemeMode());

    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return null;
}
