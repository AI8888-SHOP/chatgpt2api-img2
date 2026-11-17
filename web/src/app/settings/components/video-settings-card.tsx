"use client";

import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { VideoModelConfig, VideoChannelConfig } from "@/lib/api";
import { useSettingsStore } from "../store";

const preset = (protocol: "grok" | "seedance" | "native"): VideoModelConfig => protocol === "grok"
  ? { id: "grok-imagine-video-1.5", label: "Grok 视频 1.5", protocol, enabled: true, max_reference_images: 14, supports_voice: true, supports_audio_upload: false, supports_video_reference: false, supports_edit: false, supports_extend: false, min_duration: 1, max_duration: 15, reference_max_duration: 15, resolutions: ["480p", "720p"] }
  : { id: "seedance-video", label: "Seedance 视频", protocol, enabled: true, max_reference_images: 9, supports_voice: false, supports_audio_upload: false, supports_video_reference: false, supports_edit: false, supports_extend: false, min_duration: 4, max_duration: 15, reference_max_duration: 15, resolutions: ["480p", "720p"] };

export function VideoSettingsCard() {
  const { config, isSavingConfig, isLoadingConfig, setConfigValue, saveConfig } = useSettingsStore();
  const models = config?.video_models || [];
  const channels = config?.video_upstreams || [];
  const editModel = (i: number, update: Partial<VideoModelConfig>) => setConfigValue("video_models", models.map((m, index) => index === i ? { ...m, ...update } : m));
  const editChannel = (i: number, update: Partial<VideoChannelConfig>) => setConfigValue("video_upstreams", channels.map((m, index) => index === i ? { ...m, ...update } : m));
  return <Card data-testid="video-settings-card" className="rounded-2xl">
    <CardContent className="space-y-6 p-6">
      <p className="text-sm text-muted-foreground">每个模型可按清晰度填写独立的每秒积分。留空沿用下方默认价格，修改默认价不影响已设置独立价格的模型。</p>
      <div><h2 className="text-lg font-semibold">视频生成</h2><p className="text-sm text-muted-foreground">独立配置视频模型和渠道。首页只展示已启用且有可用渠道的模型。</p></div>
      <fieldset disabled={!config || isLoadingConfig || isSavingConfig} className="space-y-6 disabled:opacity-60">
        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={config?.video_enabled === true} onCheckedChange={v => setConfigValue("video_enabled", v === true)} />启用首页视频生成与 API</label>
          <label className="flex items-center gap-2 text-sm">480p 每秒积分<Input aria-label="视频每秒积分" type="number" min={1} max={1000} className="w-24" value={config?.video_credits_per_second ?? 1} onChange={e => setConfigValue("video_credits_per_second", Math.max(1, Math.min(1000, Math.trunc(Number(e.target.value) || 1))))} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm">720p 每秒积分<Input aria-label="720p 每秒积分" type="number" min={1} max={10000} className="w-24" value={config?.video_720p_credits_per_second ?? (config?.video_credits_per_second ?? 1) * 2} onChange={e => setConfigValue("video_720p_credits_per_second", Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))))} /></label>
        <label className="flex items-center gap-2 text-sm">1080p 每秒积分<Input aria-label="1080p 每秒积分" type="number" min={1} max={10000} value={config?.video_1080p_credits_per_second ?? (config?.video_credits_per_second ?? 1) * 4} onChange={e => setConfigValue("video_1080p_credits_per_second", Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))))} /></label>
        <p className="text-xs text-muted-foreground">按时长乘以对应分辨率单价计费。每用户每分钟一次、同时一个任务，全站最多八个。实际供应商费用与本站积分独立。</p>
        <label className="block space-y-2 text-sm">素材公网地址（Seedance / 原生协议上传素材时必填）
          <Input aria-label="视频素材公网地址" placeholder="https://img.example.com" value={config?.video_public_base_url || ""} onChange={e => setConfigValue("video_public_base_url", e.target.value)} />
          <span className="block text-xs text-muted-foreground">填写本站可被上游访问的 HTTPS 地址，必须能访问 /video-assets/。素材以随机链接供上游读取，48 小时后过期。</span>
        </label>
        <div className="space-y-3"><h3 className="font-medium">前端视频模型</h3>
          {models.map((model, index) => <div key={index} className="space-y-3 rounded-xl border p-4" data-testid="video-model-row">
            <div className="grid gap-3 sm:grid-cols-3">{model.resolutions.map(res => { const key = `price_${res}` as const; const fallback = res === "1080p" ? config?.video_1080p_credits_per_second ?? (config?.video_credits_per_second ?? 1) * 4 : res === "720p" ? config?.video_720p_credits_per_second ?? (config?.video_credits_per_second ?? 1) * 2 : config?.video_credits_per_second ?? 1; return <label key={res} className="text-sm">{res} 积分/秒<Input aria-label={`${res}模型单价 ${index + 1}`} type="number" min={1} max={10000} value={model[key] ?? ""} placeholder={`默认 ${fallback}`} onChange={e => editModel(index, { [key]: e.target.value === "" ? null : Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))) })} /></label>; })}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-sm">模型 ID<Input aria-label={`视频模型 ID ${index + 1}`} value={model.id} maxLength={100} onChange={e => editModel(index, { id: e.target.value })} /></label>
              <label className="space-y-1 text-sm">显示名称<Input aria-label={`视频模型名称 ${index + 1}`} value={model.label} onChange={e => editModel(index, { label: e.target.value })} /></label>
              <label className="space-y-1 text-sm">接口协议<select aria-label={`视频模型协议 ${index + 1}`} className="h-9 w-full rounded-md border bg-background px-2" value={model.protocol} onChange={e => editModel(index, { ...preset(e.target.value as "grok" | "seedance" | "native"), id: model.id, label: model.label, enabled: model.enabled, resolutions: model.resolutions, price_480p: model.price_480p, price_720p: model.price_720p, price_1080p: model.price_1080p })}><option value="grok">Grok · request_id / done / video.url</option><option value="native">原生 · id / completed / content</option><option value="seedance">Seedance · Ark 原生任务</option></select></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              {model.protocol === "grok" && <label className="space-y-1 text-sm">Grok 网关路径<select aria-label={`Grok 网关路径 ${index + 1}`} className="h-9 w-full rounded-md border bg-background px-2" value={model.grok_endpoint ?? "generations"} onChange={e => editModel(index, { grok_endpoint: e.target.value as "generations" | "videos" })}><option value="generations">/v1/videos/generations</option><option value="videos">/v1/videos（Grok 别名）</option></select><span className="block text-xs text-muted-foreground">别名只改变路径，仍使用 duration、request_id、done 和 video.url。请按网关合同选择。</span></label>}
              {([['min_duration','最短秒数',1,15],['max_duration','最长秒数',1,15],['reference_max_duration','参考模式最长秒数',1,15],['max_reference_images','参考图上限',0,model.protocol === 'grok' ? 14 : 9]] as const).map(([key,label,min,max]) => <label key={key} className="space-y-1 text-sm">{label}<Input aria-label={`${label} ${index + 1}`} type="number" min={min} max={max} value={model[key]} onChange={e => editModel(index, { [key]: Math.max(min, Math.min(max, Math.trunc(Number(e.target.value) || min))) })} /></label>)}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2"><Checkbox checked={model.enabled} onCheckedChange={v => editModel(index, { enabled: v === true })} />启用</label>
              <label className="flex items-center gap-2"><input type="radio" name="default-video-model" aria-label={`默认视频模型 ${index + 1}`} checked={config?.default_video_model === model.id && Boolean(model.id)} onChange={() => setConfigValue("default_video_model", model.id)} />默认</label>
              {(["480p", "720p", "1080p"] as const).map(res => <label key={res} className="flex items-center gap-2"><Checkbox checked={model.resolutions.includes(res)} onCheckedChange={v => editModel(index, { resolutions: v === true ? [...model.resolutions, res] : model.resolutions.filter(r => r !== res) })} />{res}</label>)}
              {model.protocol === "grok" ? <label className="flex items-center gap-2"><Checkbox checked={model.supports_voice} onCheckedChange={v => editModel(index, { supports_voice: v === true })} />支持预设音色（1.5）</label> : <label className="flex items-center gap-2"><Checkbox checked={model.supports_audio_upload} onCheckedChange={v => editModel(index, { supports_audio_upload: v === true })} />已确认上游支持参考音频上传</label>}
              {model.protocol === "native" && ([["supports_video_reference", "参考视频"], ["supports_edit", "视频编辑"], ["supports_extend", "视频延长"]] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><Checkbox checked={model[key] === true} onCheckedChange={v => editModel(index, { [key]: v === true })} />{label}</label>)}
              <Button variant="ghost" size="icon" aria-label={`删除视频模型 ${index + 1}`} onClick={() => setConfigValue("video_models", models.filter((_, i) => i !== index))}><Trash2 size={16} /></Button>
            </div>
          </div>)}
          <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setConfigValue("video_models", [...models, preset("grok")])}><Plus size={16} />添加 Grok 视频模型</Button><Button variant="outline" onClick={() => setConfigValue("video_models", [...models, preset("seedance")])}><Plus size={16} />添加 Seedance 视频模型</Button></div>
          <p className="text-xs text-muted-foreground">模型 ID 应与渠道一致，可使用上游别名。旧版 Grok 参考模式最多 7 图、10 秒，不支持预设音色。Seedance 需较新版本 sub2api 的 Ark 原生接口，音频能力还取决于实际模型。</p>
        </div>
        <div className="space-y-3"><h3 className="font-medium">视频渠道</h3>
          {channels.map((channel, index) => <div key={index} className="space-y-3 rounded-xl border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">渠道名称<Input aria-label={`视频渠道名称 ${index + 1}`} value={channel.name} onChange={e => editChannel(index, { name: e.target.value })} /></label>
              <label className="space-y-1 text-sm">Base URL<Input aria-label={`视频渠道地址 ${index + 1}`} placeholder="https://sub2api.example.com" value={channel.base_url} onChange={e => editChannel(index, { base_url: e.target.value })} /></label>
              <label className="space-y-1 text-sm">API Key<Input aria-label={`视频渠道密钥 ${index + 1}`} type="password" autoComplete="new-password" value={channel.api_key} onChange={e => editChannel(index, { api_key: e.target.value })} /></label>
              <label className="space-y-1 text-sm">支持模型（逗号分隔）<Input aria-label={`视频渠道模型 ${index + 1}`} value={channel.models.join(",")} onChange={e => editChannel(index, { models: e.target.value.split(",") })} /></label>
            </div>
            <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><Checkbox checked={channel.enabled} onCheckedChange={v => editChannel(index, { enabled: v === true })} />启用渠道</label><Button variant="ghost" aria-label={`删除视频渠道 ${index + 1}`} onClick={() => setConfigValue("video_upstreams", channels.filter((_, i) => i !== index))}><Trash2 size={16} />删除</Button></div>
          </div>)}
          <Button variant="outline" onClick={() => setConfigValue("video_upstreams", [...channels, { name: `视频渠道 ${channels.length + 1}`, base_url: "", api_key: "", models: [], enabled: true }])}><Plus size={16} />添加视频渠道</Button>
        </div>
        <Button onClick={() => void saveConfig()}><Save size={16} />{isSavingConfig ? "保存中…" : "保存视频设置"}</Button>
      </fieldset>
    </CardContent>
  </Card>;
}
