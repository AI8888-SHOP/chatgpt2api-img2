"use client";
import { useEffect, useState } from "react";
import { FileSliders, LoaderCircle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { httpRequest } from "@/lib/request";
import type { StudioAdminConfig } from "@/lib/editable-studio";
import { useSettingsStore } from "../store";

const fields = [
  ["plan_user_rpm", "需求整理：每用户 RPM", 1, 30], ["plan_daily_requests", "需求整理：每用户每天次数", 1, 1000], ["plan_revisions", "每草稿 AI 整理次数", 1, 10],
  ["generation_user_rpm", "正式生成：每用户 RPM", 1, 20], ["user_daily_jobs", "每用户每天正式任务", 1, 1000], ["user_queue_size", "每用户排队数（另有 1 个执行位）", 0, 10],
  ["global_concurrency", "全站最大并发", 1, 16], ["global_queue_size", "全站排队上限", 1, 500],
  ["max_input_tokens", "单次文本输入 Token 上限（含固定指令）", 512, 32768], ["plan_output_tokens", "整理输出 Token 上限（含思考）", 1024, 32768],
  ["generation_output_tokens", "生成单次输出 Token 上限（含思考）", 4096, 65536], ["task_output_tokens", "生成整任务输出预算（含重试）", 4096, 131072],
  ["upstream_input_reserve", "每次上游额外输入 Token 预留", 0, 131072], ["image_token_reserve", "每张图片 Token 预留", 1024, 32768],
  ["user_daily_tokens", "每用户每日总 Token 预算", 8192, 10000000], ["global_daily_tokens", "全站每日总 Token 预算", 32768, 100000000],
  ["request_timeout_seconds", "API 单次超时（秒）", 30, 600], ["task_timeout_seconds", "任务总超时（秒）", 120, 1800], ["max_retries", "AI 自动重试次数", 0, 1],
  ["max_pages", "PPT 最大页数", 3, 40], ["max_layers", "PSD 最大图层（含背景）", 2, 60], ["max_image_mb", "每张图片最大 MB", 1, 20],
  ["max_image_pixels", "每张图片最大像素数", 1000000, 24000000], ["max_reference_images", "PPT 最多参考图", 1, 8], ["max_file_mb", "每个生成文件最大 MB", 5, 300],
  ["max_storage_mb", "工作室总存储预算 MB（含执行预留）", 256, 51200], ["render_memory_mb", "单个渲染进程虚拟内存上限 MB", 768, 4096],
  ["min_quota", "最低积分余额", 0, 100000], ["min_account_age_seconds", "新账号等待时间（秒）", 0, 2592000],
  ["ppt_page_price", "PPT 每页积分", 0, 10000], ["psd_task_price", "PSD 每任务积分", 0, 100000], ["retention_days", "文件保留天数", 1, 90],
] as const;
type Stats = { daily_tokens: number; jobs: { status: string; count: number }[]; recent: { id: string; kind: string; status: string; phase: string; error: string; actual_tokens: number | null }[] };

export function EditableStudioCard() {
  const config = useSettingsStore(s => s.config); const saving = useSettingsStore(s => s.isSavingConfig);
  const setValue = useSettingsStore(s => s.setConfigValue); const save = useSettingsStore(s => s.saveConfig);
  const [stats, setStats] = useState<Stats | null>(null); const [error, setError] = useState("");
  const settings: StudioAdminConfig = { enabled: false, reuse_optimizer_connection: true, base_url: "", api_key: "", model: "", protocol: "responses", reasoning_effort: "medium", ...config?.editable_studio };
  const patch = (next: Partial<StudioAdminConfig>) => setValue("editable_studio", { ...settings, ...next } as StudioAdminConfig);
  const refresh = () => httpRequest<Stats>("/api/editable-studio/stats", { authScope: "admin", redirectOnUnauthorized: false }).then(s => { setStats(s); setError(""); }).catch(() => setError("暂时无法读取任务统计"));
  useEffect(() => { void refresh(); }, []);
  return <Card><CardContent className="space-y-5 p-6">
    <div className="flex gap-3"><FileSliders className="size-5" /><div><h2 className="text-lg font-semibold">PPT / PSD 文档工作室 · 独立 API</h2><p className="text-sm text-stone-500">AI 分析与内容制作，受控程序导出真实可编辑文件。不使用 ChatGPT 账号池。</p></div></div>
    <fieldset disabled={!config || saving} className="space-y-5">
      <label className="flex gap-3 text-sm"><input type="checkbox" checked={settings.enabled} onChange={e => patch({ enabled: e.target.checked })} />启用 API 文档工作室</label>
      <label className="flex gap-3 text-sm"><input type="checkbox" checked={settings.reuse_optimizer_connection} onChange={e => patch({ reuse_optimizer_connection: e.target.checked })} />复用提示词优化的 API 地址、密钥、模型（不受其启用开关影响）</label>
      {!settings.reuse_optimizer_connection && <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm">API Base URL（含 /v1）<Input value={settings.base_url} onChange={e => patch({ base_url: e.target.value })} /></label>
        <label className="space-y-2 text-sm">模型 ID<Input value={settings.model} onChange={e => patch({ model: e.target.value })} /></label>
        <label className="space-y-2 text-sm">API Key<Input type="password" autoComplete="new-password" value={settings.api_key} placeholder={settings.has_api_key ? "留空保留已存密钥" : "输入密钥"} onChange={e => patch({ api_key: e.target.value, clear_api_key: false })} /></label>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={!!settings.clear_api_key} onChange={e => patch({ clear_api_key: e.target.checked, ...(e.target.checked ? { api_key: "", enabled: false } : {}) })} />清除密钥并停用</label>
      </div>}
      <div className="grid gap-4 md:grid-cols-2"><label className="space-y-2 text-sm">协议<select className="block w-full rounded-md border p-2" value={settings.protocol} onChange={e => patch({ protocol: e.target.value })}><option value="responses">Responses API</option><option value="chat_completions">Chat Completions（视觉模型）</option></select></label><label className="space-y-2 text-sm">思考强度<select className="block w-full rounded-md border p-2" value={settings.reasoning_effort} onChange={e => patch({ reasoning_effort: e.target.value })}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label></div>
      <details><summary className="cursor-pointer text-sm font-semibold">用户限流、Token 预算、文件限制与积分价格</summary><div className="mt-4 grid gap-4 md:grid-cols-2">{fields.map(([key, label, min, max]) => <label className="space-y-2 text-sm" key={key}>{label}<Input type="number" min={min} max={max} step={1} value={Number(settings[key] ?? min)} onChange={e => patch({ [key]: Number(e.target.value) })} /></label>)}</div></details>
      <p className="text-xs leading-6 text-stone-500">预算按用户 ID 计数，跨会话和重启生效。UTC 零点重置。先预留输入、图片、上游额外指令与最大输出；成功按上游用量结算，未知用量保留预算。失败请求也计次。生成积分与任务状态在同一数据库事务中扣除或退回。仅支持网页登录，但仍需依靠后端预算限制自动化滥用。</p>
      <p className="text-xs leading-6 text-stone-500">PSD 为视觉引导的原图像素分层，文字不会伪装成可编辑字体。近似背景修补不代表恢复原始遮挡信息。AI 不直接执行代码，文件下载校验所属用户。</p>
      <div className="flex justify-end"><Button disabled={!config || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}保存工作室配置</Button></div>
    </fieldset>
    <div className="space-y-3 border-t pt-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">任务运行状态</h3><Button variant="outline" size="sm" onClick={() => void refresh()}>刷新统计</Button></div>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}{stats && <><p className="text-sm">今日已用 / 预留 Token：{stats.daily_tokens.toLocaleString()}</p><div className="flex flex-wrap gap-4 text-sm">{stats.jobs.map(x => <span key={x.status}>{x.status}：{x.count}</span>)}</div><div className="max-h-60 space-y-2 overflow-auto text-xs">{stats.recent.map(j => <div className="rounded border p-2" key={j.id}><span>{j.kind.toUpperCase()} · {j.id.slice(0, 8)} · {j.phase} · Token {j.actual_tokens ?? "预留中 / 未知"}</span>{j.error && <p className="mt-1 text-red-600">{j.error}</p>}</div>)}</div></>}</div>
  </CardContent></Card>;
}
