"use client";

import { useEffect } from "react";

import { fetchPublicAppConfig } from "@/lib/api";

export const DEFAULT_SITE_TITLE = "image 专业绘图";

export function applySiteTitle(siteTitle: string) {
  const title = siteTitle.trim() || DEFAULT_SITE_TITLE;
  document.title = title;
  document.documentElement.dataset.siteTitle = title;
  window.dispatchEvent(new CustomEvent("app:site-title", { detail: { siteTitle: title } }));
}

export function AppTitle() {
  useEffect(() => {
    let cancelled = false;

    const loadTitle = async () => {
      try {
        const data = await fetchPublicAppConfig();
        if (!cancelled) applySiteTitle(data.site_title);
      } catch {
        if (!cancelled) applySiteTitle(DEFAULT_SITE_TITLE);
      }
    };

    void loadTitle();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
