"use client";

import { LoaderCircle, Save, Type } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { useSettingsStore } from "../store";

export function SiteBrandingCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setConfigValue = useSettingsStore((state) => state.setConfigValue);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
            <Type className="size-5 text-stone-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">网站标题</h2>
            <p className="text-sm text-stone-500">用于浏览器标题、顶部导航和菜单标题。</p>
          </div>
        </div>

        {isLoadingConfig ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">标题</label>
              <Input
                value={String(config?.site_title || "")}
                onChange={(event) => setConfigValue("site_title", event.target.value)}
                placeholder="image 专业绘图"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>

            <div className="flex justify-end">
              <Button
                className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
                onClick={() => void saveConfig()}
                disabled={isSavingConfig}
              >
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存标题
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
