"use client";

import { LoaderCircle, Plus, Save, ServerCog, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ImageUpstreamConfig } from "@/lib/api";

import { useSettingsStore } from "../store";

function createUpstream(index: number): ImageUpstreamConfig {
  return {
    name: `上游 ${index + 1}`,
    base_url: "",
    api_key: "",
    model: "gpt-image-2",
    enabled: true,
  };
}

function normalizeUpstreams(items: ImageUpstreamConfig[]): ImageUpstreamConfig[] {
  return items.length > 0 ? items : [createUpstream(0)];
}

export function ImageUpstreamsCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setImageUpstreams = useSettingsStore((state) => state.setImageUpstreams);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const upstreams = normalizeUpstreams(config?.image_upstreams || []);
  const enabledCount = upstreams.filter((item) => item.enabled && item.base_url.trim() && item.api_key.trim()).length;

  const updateItem = (index: number, updates: Partial<ImageUpstreamConfig>) => {
    const next = upstreams.map((item, currentIndex) => (currentIndex === index ? { ...item, ...updates } : item));
    setImageUpstreams(next);
  };

  const addItem = () => {
    setImageUpstreams([...upstreams, createUpstream(upstreams.length)]);
  };

  const removeItem = (index: number) => {
    const next = upstreams.filter((_, currentIndex) => currentIndex !== index);
    setImageUpstreams(normalizeUpstreams(next));
  };

  const handleSave = async () => {
    const enabledValidItems = upstreams.filter((item) => item.enabled && item.base_url.trim() && item.api_key.trim());
    if (enabledValidItems.length === 0) {
      toast.error("至少保留一个启用且填写完整的生图上游");
      return;
    }
    await saveConfig();
  };

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
              <ServerCog className="size-5 text-stone-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">生图上游</h2>
              <p className="text-sm text-stone-500">配置 OpenAI 兼容图片接口。多个启用上游会按请求轮询使用。</p>
            </div>
          </div>
          <Badge variant={enabledCount > 0 ? "success" : "secondary"} className="w-fit rounded-md px-2.5 py-1">
            {enabledCount > 0 ? `${enabledCount} 个启用` : "未配置"}
          </Badge>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            余额不足冷却（秒）
            <Input
              type="number"
              min={0}
              className="h-9 w-24 rounded-xl border-stone-200 bg-white"
              value={config?.image_upstream_cooldown_secs ?? 600}
              onChange={(event) => useSettingsStore.getState().setConfigValue("image_upstream_cooldown_secs", Math.max(0, Number(event.target.value || 0)))}
            />
          </label>
        </div>

        {isLoadingConfig ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {upstreams.map((item, index) => (
                <div key={index} className="rounded-2xl border border-stone-200 bg-white p-4">
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <label className="flex items-center gap-2 text-sm font-medium text-stone-700">
                      <Checkbox checked={item.enabled} onCheckedChange={(checked) => updateItem(index, { enabled: checked === true })} />
                      启用上游
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 rounded-xl border-stone-200 bg-white px-3 text-stone-600"
                      onClick={() => removeItem(index)}
                      disabled={upstreams.length <= 1}
                    >
                      <Trash2 className="size-4" />
                      删除
                    </Button>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-stone-700">名称</label>
                      <Input
                        value={item.name}
                        onChange={(event) => updateItem(index, { name: event.target.value })}
                        placeholder="xiaoleai"
                        className="h-11 rounded-xl border-stone-200 bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-stone-700">Base URL</label>
                      <Input
                        value={item.base_url}
                        onChange={(event) => updateItem(index, { base_url: event.target.value })}
                        placeholder="https://api.example.com/v1"
                        className="h-11 rounded-xl border-stone-200 bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-stone-700">模型</label>
                      <Input
                        value={item.model}
                        onChange={(event) => updateItem(index, { model: event.target.value })}
                        placeholder="gpt-image-2"
                        className="h-11 rounded-xl border-stone-200 bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-stone-700">API Key</label>
                      <Input
                        type="password"
                        value={item.api_key}
                        onChange={(event) => updateItem(index, { api_key: event.target.value })}
                        placeholder="sk-..."
                        className="h-11 rounded-xl border-stone-200 bg-white"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              <Button type="button" variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-5 text-stone-700" onClick={addItem}>
                <Plus className="size-4" />
                添加上游
              </Button>
              <Button className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void handleSave()} disabled={isSavingConfig}>
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存上游
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
