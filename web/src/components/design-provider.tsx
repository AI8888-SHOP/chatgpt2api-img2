"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { httpRequest } from "@/lib/request";

export type DesignVariant = "a" | "b";
export type DesignPreference = DesignVariant | "equal" | null;
export type UiTrial = { trial_id: string; assigned_variant: DesignVariant; variant: DesignVariant; preference: DesignPreference; seen_a: boolean; seen_b: boolean };
const STORAGE_KEY = "app:studio-design";
const endpoint = "/v1/user/ui-trial";
const valid = (value: unknown): value is DesignVariant => value === "a" || value === "b";
type DesignContextValue = { variant: DesignVariant; trial: UiTrial | null; busy: boolean; error: string; choose: (value: DesignVariant) => Promise<void>; vote: (value: DesignPreference) => Promise<void>; retry: () => void };
const DesignContext = createContext<DesignContextValue | null>(null);

export function DesignProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname().replace(/\/+$/, "") || "/";
  const userArea = ["/image", "/editable-files", "/api-keys", "/recharge"].includes(pathname);
  const [variant, setVariant] = useState<DesignVariant>("a");
  const [trial, setTrial] = useState<UiTrial | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const saving = useRef(false);

  const apply = (next: DesignVariant) => {
    setVariant(next);
    document.documentElement.dataset.design = next;
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Private mode storage is optional. */ }
  };
  useEffect(() => {
    try { const saved = window.localStorage.getItem(STORAGE_KEY); if (valid(saved)) apply(saved); } catch { /* Defaults remain usable. */ }
  }, []);

  useEffect(() => {
    const requestEpoch = ++epoch.current;
    saving.current = false;
    setTrial(null); setError("");
    if (!userArea) { setBusy(false); return; }
    setBusy(true);
    void (async () => {
      try {
        const result = await httpRequest<UiTrial>(endpoint, { authScope: "user", redirectOnUnauthorized: false, timeout: 10000 });
        if (!valid(result.variant)) throw new Error("暂时无法加载试用配置");
        if (epoch.current !== requestEpoch) return;
        apply(result.variant); setTrial(result);
        const seen = await httpRequest<UiTrial>(endpoint, { method: "POST", body: { variant: result.variant }, authScope: "user", redirectOnUnauthorized: false, timeout: 10000 });
        if (epoch.current === requestEpoch) setTrial(seen);
      } catch { if (epoch.current === requestEpoch) setError("偏好同步暂不可用，不影响绘图。请重试。"); }
      finally { if (epoch.current === requestEpoch) setBusy(false); }
    })();
    return () => { ++epoch.current; };
  }, [userArea, reload]);

  const save = async (body: { variant?: DesignVariant; preference?: DesignPreference }) => {
    if (busy || saving.current) return;
    if (!userArea) { if (body.variant) apply(body.variant); return; }
    const requestEpoch = epoch.current;
    saving.current = true; setBusy(true); setError("");
    try {
      const result = await httpRequest<UiTrial>(endpoint, { method: "POST", body, authScope: "user", redirectOnUnauthorized: false, timeout: 10000 });
      if (!valid(result.variant)) throw new Error("无效的试用配置");
      if (epoch.current !== requestEpoch) return;
      apply(result.variant); setTrial(result);
    } catch (cause) {
      if (epoch.current === requestEpoch) setError(cause instanceof Error ? cause.message : "保存失败，请重试");
    } finally {
      if (epoch.current === requestEpoch) { saving.current = false; setBusy(false); }
    }
  };
  return <DesignContext.Provider value={{ variant, trial, busy, error, choose: value => save({ variant: value }), vote: value => save({ preference: value }), retry: () => setReload(value => value + 1) }}>{children}</DesignContext.Provider>;
}

export function useDesign() {
  const context = useContext(DesignContext);
  if (!context) throw new Error("DesignProvider is required");
  return context;
}
