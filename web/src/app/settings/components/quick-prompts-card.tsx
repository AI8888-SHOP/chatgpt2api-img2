"use client";

import { LoaderCircle, Plus, Save, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { QuickPromptConfig } from "@/lib/api";

import { useSettingsStore } from "../store";

function createQuickPrompt(index: number): QuickPromptConfig {
  return {
    label: `快捷提示词 ${index + 1}`,
    content: "",
  };
}

export function QuickPromptsCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setQuickPrompts = useSettingsStore((state) => state.setQuickPrompts);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const quickPrompts = config?.quick_prompts || [];

  const updateItem = (index: number, updates: Partial<QuickPromptConfig>) => {
    setQuickPrompts(quickPrompts.map((item, currentIndex) => (currentIndex === index ? { ...item, ...updates } : item)));
  };

  const addItem = () => {
    setQuickPrompts([...quickPrompts, createQuickPrompt(quickPrompts.length)]);
  };

  const removeItem = (index: number) => {
    setQuickPrompts(quickPrompts.filter((_, currentIndex) => currentIndex !== index));
  };

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
              <Sparkles className="size-5 text-stone-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">快捷提示词</h2>
              <p className="text-sm text-stone-500">配置图像输入面板中的下拉选项。用户选择后，会把内容追加到提示词输入框。</p>
            </div>
          </div>
          <Button type="button" variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-5 text-stone-700" onClick={addItem}>
            <Plus className="size-4" />
            添加
          </Button>
        </div>

        {isLoadingConfig ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            {quickPrompts.length > 0 ? (
              <div className="space-y-4">
                {quickPrompts.map((item, index) => (
                  <div key={index} className="rounded-2xl border border-stone-200 bg-white p-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-stone-700">选项 {index + 1}</div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-3 text-stone-600"
                        onClick={() => removeItem(index)}
                      >
                        <Trash2 className="size-4" />
                        删除
                      </Button>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-stone-700">下拉显示名称</label>
                        <Input
                          value={item.label}
                          onChange={(event) => updateItem(index, { label: event.target.value })}
                          placeholder={`快捷提示词 ${index + 1}`}
                          className="h-11 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-stone-700">追加到输入框的内容</label>
                        <Textarea
                          value={item.content}
                          onChange={(event) => updateItem(index, { content: event.target.value })}
                          placeholder="例如：保留人物主体和产品外观不变，只优化背景、光影和整体质感。"
                          className="min-h-28 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-stone-200 bg-stone-50 p-8 text-center text-sm text-stone-500">
                暂未配置快捷提示词。
              </div>
            )}

            <div className="flex justify-end">
              <Button className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void saveConfig()} disabled={isSavingConfig}>
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存快捷提示词
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
