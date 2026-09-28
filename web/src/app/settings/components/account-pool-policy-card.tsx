"use client";

import { LoaderCircle, Save, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

import { useSettingsStore } from "../store";

export function AccountPoolPolicyCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setAutoRemoveAbnormalAccounts = useSettingsStore((state) => state.setAutoRemoveAbnormalAccounts);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const autoRemoveEnabled = config?.auto_remove_abnormal_accounts === true;

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
            <ShieldAlert className="size-5 text-stone-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">号池策略</h2>
            <p className="text-sm text-stone-500">控制系统发现封号、失效账号后的处理方式。</p>
          </div>
        </div>

        {isLoadingConfig ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-stone-800">自动移除异常账号</span>
                <span className="block text-xs text-stone-500">开启后，刷新号池或出图巡检发现 401 封号时会直接从号池删除；关闭时仅标记为异常。</span>
              </span>
              <Checkbox checked={autoRemoveEnabled} onCheckedChange={(checked) => setAutoRemoveAbnormalAccounts(checked === true)} />
            </label>

            <div className="flex justify-end">
              <Button
                className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
                onClick={() => void saveConfig()}
                disabled={isSavingConfig}
              >
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存策略
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
