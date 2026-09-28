"use client";

import { LoaderCircle, Save, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { useSettingsStore } from "../store";

export function UserQuotaCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setDefaultUserQuota = useSettingsStore((state) => state.setDefaultUserQuota);
  const setUserRegistrationEnabled = useSettingsStore((state) => state.setUserRegistrationEnabled);
  const setConfigValue = useSettingsStore((state) => state.setConfigValue);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const quota = Math.max(0, Number(config?.default_user_quota || 0));
  const registrationEnabled = config?.user_registration_enabled !== false;
  const inviteEnabled = config?.invite_registration_enabled !== false;

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
            <UserPlus className="size-5 text-stone-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">用户积分与任务价格</h2>
            <p className="text-sm text-stone-500">控制自助注册赠送积分、邀请奖励和 PSD 任务扣费。</p>
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
                <span className="block text-sm font-medium text-stone-800">开放自助注册</span>
                <span className="block text-xs text-stone-500">关闭后，前台只能登录已有账号，注册接口也会拒绝新账号。</span>
              </span>
              <input
                type="checkbox"
                checked={registrationEnabled}
                onChange={(event) => setUserRegistrationEnabled(event.target.checked)}
                className="size-4"
              />
            </label>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">默认赠送积分</label>
              <Input
                type="number"
                min={0}
                value={quota}
                onChange={(event) => setDefaultUserQuota(Number(event.target.value))}
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">PSD 每图积分</label>
              <Input
                type="number"
                min={0}
                value={Math.max(0, Number(config?.psd_task_price ?? 1))}
                onChange={(event) => setConfigValue("psd_task_price", Math.max(0, Number(event.target.value) || 0))}
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-stone-800">开启用户邀请奖励</span>
                <span className="block text-xs text-stone-500">用户通过邀请链接注册后，邀请人和新用户都会获得生图积分。</span>
              </span>
              <input
                type="checkbox"
                checked={inviteEnabled}
                onChange={(event) => setConfigValue("invite_registration_enabled", event.target.checked)}
                className="size-4"
              />
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">邀请人奖励积分</label>
                <Input
                  type="number"
                  min={0}
                  value={Math.max(0, Number(config?.invite_inviter_quota || 0))}
                  onChange={(event) => setConfigValue("invite_inviter_quota", Math.max(0, Number(event.target.value) || 0))}
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">被邀请人奖励积分</label>
                <Input
                  type="number"
                  min={0}
                  value={Math.max(0, Number(config?.invite_invited_quota || 0))}
                  onChange={(event) => setConfigValue("invite_invited_quota", Math.max(0, Number(event.target.value) || 0))}
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
                onClick={() => void saveConfig()}
                disabled={isSavingConfig}
              >
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存配置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
