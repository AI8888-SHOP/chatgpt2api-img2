"use client";

import { useEffect, useState } from "react";
import { Crop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { imageSizeAllowed, imageSizeOptions, restrictedImageSizes, validImageSize } from "@/lib/image-sizes";

export function AspectRatioSelect({ value, onChange, model }: { value: string; onChange: (size: string) => void; model: string }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(value === "auto" ? "" : value);
  const restricted = !!restrictedImageSizes(model);
  const options = imageSizeOptions(model);
  const allowed = imageSizeAllowed(model, value);
  const customValue = allowed && value !== "auto" && !options.some(option => option.value === value);
  useEffect(() => {
    setCustomOpen(false);
    setDraft(value === "auto" ? "" : value);
    // A restricted model needs a new explicit choice, never a lower fallback.
    if (value && !imageSizeAllowed(model, value)) onChange("");
  }, [model, value, onChange]);
  return <div className="flex min-w-0 flex-col gap-1 sm:max-w-[280px]">
    <Select value={allowed ? value : ""} onValueChange={next => {
      if (next === "__custom__") { setCustomOpen(true); return; }
      if (imageSizeAllowed(model, next)) { setCustomOpen(false); onChange(next); }
    }}>
      <SelectTrigger aria-label="图片请求尺寸" className="h-9 w-full rounded-full bg-white/80 text-xs">
        <Crop className="mr-1 size-3.5 shrink-0" /><SelectValue placeholder="请选择请求尺寸" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">自动{restricted ? "（1024×1024）" : ""}</SelectItem>
        {options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        {customValue && <SelectItem value={value}>自定义 · {value.replace("x", "×")}</SelectItem>}
        {!restricted && <SelectItem value="__custom__">自定义像素尺寸…</SelectItem>}
      </SelectContent>
    </Select>
    <p className="text-[10px] leading-4 text-muted-foreground">{restricted ? "按现有模型协议提供尺寸。" : "尺寸能力待上游确认；可自定义请求，不保证上游接受或成品像素。"}{!value && " 请重新选择尺寸。"}</p>
    {!restricted && customOpen && <div className="flex flex-wrap gap-1">
      <Input aria-label="自定义图片尺寸" placeholder="例如 3840x2160" value={draft} onChange={event => setDraft(event.target.value)} className="h-8 w-[160px] text-xs" />
      <Button type="button" variant="outline" className="h-8 px-2 text-xs" disabled={!validImageSize(draft) || draft === "auto"} onClick={() => { onChange(draft); setCustomOpen(false); }}>应用尺寸</Button>
      <p className="w-full text-[10px] text-muted-foreground">宽x高，单位像素；点击“应用尺寸”后生效。</p>
    </div>}
  </div>;
}
