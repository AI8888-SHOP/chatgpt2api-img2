"use client";

import { ArrowDown, ArrowUp, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ImageModelConfig } from "@/lib/api";
import { useSettingsStore } from "../store";

export function ImageModelsCard() {
  const { config, isLoadingConfig, isSavingConfig, saveConfig, setConfigValue } = useSettingsStore();
  const items = config?.image_models || [];
  const defaultModel = config?.default_image_model || "";
  const update = (next: ImageModelConfig[], selected = defaultModel) => {
    const available = next.filter(item => item.enabled !== false && item.id.trim());
    const nextDefault = available.some(item => item.id.trim() === selected.trim()) ? selected.trim() : available[0]?.id.trim() || "";
    useSettingsStore.setState(state => ({ config: state.config ? {
      ...state.config, image_models: next, default_image_model: nextDefault,
    } : null }));
  };
  const edit = (index: number, changes: Partial<ImageModelConfig>) => {
    const next = items.map((item, i) => i === index ? { ...item, ...changes } : item);
    update(next, items[index].id.trim() === defaultModel ? next[index].id : defaultModel);
  };
  const move = (index: number, offset: number) => {
    const next = [...items];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    update(next);
  };

  return <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm" data-testid="image-models-card">
    <CardContent className="space-y-5 p-6">
      <p className="text-sm text-muted-foreground">下方默认价仅用于未填写独立价格的模型。每个模型可分别设置文生图、图生图积分；留空沿用默认价。</p>
      <fieldset disabled={!config || isLoadingConfig || isSavingConfig} className="flex flex-wrap gap-4">
        <label className="space-y-1 text-sm">文生图每张积分<Input aria-label="文生图每张积分" type="number" min={1} max={10000} value={config?.image_generate_price ?? 1} onChange={e => setConfigValue("image_generate_price", Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))))} /></label>
        <label className="space-y-1 text-sm">图生图每张积分<Input aria-label="图生图每张积分" type="number" min={1} max={10000} value={config?.image_edit_price ?? 1} onChange={e => setConfigValue("image_edit_price", Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))))} /></label>
      </fieldset>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">前端可用模型</h2>
        <p className="text-sm text-stone-500">控制绘图页面的模型名称、顺序和默认选项。自定义模型 ID 需与下方已接入的生图上游一致。</p>
      </div>
      {isLoadingConfig ? <LoaderCircle className="size-5 animate-spin" /> : <>
        {items.length === 0 && <p className="text-sm text-stone-500">尚无模型，保存后前端将暂停生成。</p>}
        <div className="space-y-3">
          {items.map((item, index) => <div key={index} className="space-y-3 rounded-xl border border-stone-200 p-4" data-testid="image-model-row">
            <div className="grid gap-3 sm:grid-cols-2">{([['generate_price','文生图',config?.image_generate_price ?? 1],['edit_price','图生图',config?.image_edit_price ?? 1]] as const).map(([key,label,fallback]) => <label key={key} className="text-sm">{label}积分/张<Input aria-label={`${label}模型单价 ${index + 1}`} type="number" min={1} max={10000} value={item[key] ?? ""} placeholder={`默认 ${fallback}`} onChange={e => edit(index, { [key]: e.target.value === "" ? undefined : Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))) })} /></label>)}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">模型 ID
                <Input aria-label={`模型 ID ${index + 1}`} value={item.id} onChange={event => edit(index, { id: event.target.value })} maxLength={128} placeholder="与生图上游模型一致" />
              </label>
              <label className="space-y-1 text-sm">显示名称
                <Input aria-label={`显示名称 ${index + 1}`} value={item.label} onChange={event => edit(index, { label: event.target.value })} maxLength={80} placeholder="留空使用模型 ID" />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={item.enabled !== false} onCheckedChange={checked => edit(index, { enabled: checked === true })} />启用</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="default-image-model" aria-label={`设为默认模型 ${index + 1}`} checked={Boolean(item.id.trim()) && item.id.trim() === defaultModel} disabled={item.enabled === false || !item.id.trim()} onChange={() => update(items, item.id)} />默认</label>
              <div className="ml-auto flex gap-1">
                <Button variant="ghost" size="icon" aria-label={`上移模型 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label={`下移模型 ${index + 1}`} disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label={`删除模型 ${index + 1}`} onClick={() => update(items.filter((_, i) => i !== index))}><Trash2 className="size-4" /></Button>
              </div>
            </div>
          </div>)}
        </div>
        {items.length > 0 && items.every(item => item.enabled === false) && <p className="text-sm text-amber-700">所有模型均已停用，保存后前端将暂停生成。</p>}
        <div className="flex flex-wrap justify-between gap-3">
          <Button variant="outline" disabled={!config || items.length >= 50} onClick={() => update([...items, { id: "", label: "", enabled: true }])}><Plus className="size-4" />添加模型</Button>
          <Button disabled={!config || isSavingConfig} onClick={() => void saveConfig()}>{isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}保存模型</Button>
        </div>
      </>}
    </CardContent>
  </Card>;
}
