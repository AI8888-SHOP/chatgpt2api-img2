"use client";

import { LoaderCircle, Save, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PromptOptimizerConfig } from "@/lib/api";
import { useSettingsStore } from "../store";

const DEFAULTS: PromptOptimizerConfig = {
  enabled: false, base_url: "", api_key: "", model: "",
  token_parameter: "max_completion_tokens", tokenizer: "cl100k_base",
  max_input_tokens: 2048, max_output_tokens: 512,
  user_rpm: 3, user_daily_requests: 30, user_daily_tokens: 30000, user_concurrency: 1,
  global_rpm: 60, global_daily_requests: 1000, global_daily_tokens: 1000000, global_concurrency: 4,
  timeout_seconds: 30, min_quota: 1, min_account_age_seconds: 600,
};

const LIMIT_FIELDS = [
  ["user_rpm", "每用户 RPM（滚动 60 秒）", 1, 60],
  ["user_daily_requests", "每用户每日请求次数", 1, 10000],
  ["user_daily_tokens", "每用户每日 token 预算", 256, 10000000],
  ["user_concurrency", "每用户最大并发", 1, 4],
  ["max_input_tokens", "每次输入 token 上限（含固定指令）", 256, 8192],
  ["max_output_tokens", "每次输出 token 上限", 64, 2048],
  ["global_rpm", "全站 RPM", 1, 1000],
  ["global_daily_requests", "全站每日请求次数", 1, 100000],
  ["global_daily_tokens", "全站每日 token 预算", 256, 100000000],
  ["global_concurrency", "全站最大并发", 1, 32],
  ["timeout_seconds", "上游请求超时（秒）", 5, 120],
  ["min_quota", "最低积分余额（0 为不限，不扣费）", 0, 100000],
  ["min_account_age_seconds", "账号注册等待时间（秒，0 为不限）", 0, 2592000],
] as const;

export function PromptOptimizerCard() {
  const config = useSettingsStore((state) => state.config);
  const loading = useSettingsStore((state) => state.isLoadingConfig);
  const saving = useSettingsStore((state) => state.isSavingConfig);
  const setConfigValue = useSettingsStore((state) => state.setConfigValue);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const settings = { ...DEFAULTS, ...config?.prompt_optimizer };
  const update = (patch: Partial<PromptOptimizerConfig>) => setConfigValue("prompt_optimizer", { ...settings, ...patch });
  const keyReady = settings.api_key.trim() || (settings.has_api_key && !settings.clear_api_key);
  const invalid = settings.enabled && (!settings.base_url.trim() || !settings.model.trim() || !keyReady);

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <WandSparkles className="size-5 text-stone-600" />
          <div>
            <h2 className="text-lg font-semibold tracking-tight">AI 提示词优化 · 独立 API</h2>
            <p className="text-sm text-stone-500">配置专用文本模型、用户限额和全站预算。仅用于绘图提示词改写。</p>
          </div>
        </div>
        {loading ? <LoaderCircle className="size-5 animate-spin" /> : (
          <fieldset disabled={!config || saving} className="space-y-5 disabled:opacity-60">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
              启用独立提示词优化 API
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span>API Base URL（含 /v1）</span>
                <Input value={settings.base_url} placeholder="https://api.example.com/v1" onChange={(event) => update({ base_url: event.target.value })} />
              </label>
              <label className="space-y-2 text-sm">
                <span>文本模型名称</span>
                <Input value={settings.model} placeholder="填写上游支持的文本模型 ID" onChange={(event) => update({ model: event.target.value })} />
              </label>
              <label className="space-y-2 text-sm">
                <span>API Key</span>
                <Input type="password" autoComplete="new-password" value={settings.api_key} placeholder={settings.has_api_key ? "已保存，留空保留原密钥" : "填写独立 API 密钥"} onChange={(event) => update({ api_key: event.target.value, clear_api_key: false })} />
              </label>
              <label className="flex items-center gap-3 text-sm">
                <input type="checkbox" checked={settings.clear_api_key === true} onChange={(event) => update({ clear_api_key: event.target.checked, ...(event.target.checked ? { api_key: "", enabled: false } : {}) })} />
                保存时清除已存密钥（同时停用）
              </label>
              <label className="space-y-2 text-sm">
                <span>上游输出限制参数</span>
                <select className="block h-10 w-full rounded-md border border-stone-200 bg-white px-3" value={settings.token_parameter} onChange={(event) => update({ token_parameter: event.target.value as PromptOptimizerConfig["token_parameter"] })}>
                  <option value="max_completion_tokens">max_completion_tokens</option>
                  <option value="max_tokens">max_tokens（兼容旧上游）</option>
                </select>
              </label>
              <label className="space-y-2 text-sm">
                <span>本地 token 计数器</span>
                <select className="block h-10 w-full rounded-md border border-stone-200 bg-white px-3" value={settings.tokenizer} onChange={(event) => update({ tokenizer: event.target.value as PromptOptimizerConfig["tokenizer"] })}>
                  <option value="cl100k_base">cl100k_base</option>
                  <option value="o200k_base">o200k_base</option>
                </select>
              </label>
              {LIMIT_FIELDS.map(([key, label, min, max]) => (
                <label key={key} className="space-y-2 text-sm">
                  <span>{label}</span>
                  <Input type="number" min={min} max={max} step={1} value={settings[key]} onChange={(event) => update({ [key]: Number(event.target.value) })} />
                </label>
              ))}
            </div>
            <p className="text-xs leading-6 text-stone-500">
              仅允许用户登录会话，拒绝用户 API Key；用户不能更换模型、系统指令、消息列表或工具。
              限额按用户账号计算，失败的上游请求也计次；每日预算按“本次输入 + 最大输出”预留、不退回，UTC 零点重置。
              计数持久化，重启不清零。第三方模型的实际分词可能不同，本地 token 为所选计数器的结果。
              固定改写指令与限额可控制用途和成本，但不能阻止已登录用户使用脚本发送请求。
            </p>
            {invalid && <p className="text-sm text-rose-600">启用前请填写 API 地址、密钥和模型。</p>}
            <div className="flex justify-end">
              <Button disabled={saving || invalid || !config} onClick={() => void saveConfig()} className="bg-stone-950 text-white hover:bg-stone-800">
                {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存配置
              </Button>
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
