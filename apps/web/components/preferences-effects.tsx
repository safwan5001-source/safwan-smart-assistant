"use client";
import { useEffect } from "react";
import { useStore } from "@/lib/hooks";
import { compactStore, themeStore } from "@/lib/stores";

/** Applies saved appearance preferences to <html>. First paint is handled by the inline script in layout. */
export default function PreferencesEffects() {
  const theme = useStore(themeStore);
  const compact = useStore(compactStore);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme; };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.compact = String(compact); }, [compact]);
  return null;
}
