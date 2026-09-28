"use client";

import { Crop } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ASPECT_RATIOS = [
  { label: "1:1", w: 1, h: 1 },
  { label: "3:2", w: 3, h: 2 },
  { label: "2:3", w: 2, h: 3 },
  { label: "4:3", w: 4, h: 3 },
  { label: "3:4", w: 3, h: 4 },
  { label: "16:9", w: 16, h: 9 },
  { label: "9:16", w: 9, h: 16 },
];

const ASPECT_RATIO_BASELINE = 2048;

function computeSize(ratioIdx: number) {
  const ratio = ASPECT_RATIOS[ratioIdx];
  if (ratio.w >= ratio.h) {
    const w = ASPECT_RATIO_BASELINE;
    const h = Math.round((w * ratio.h) / ratio.w / 16) * 16;
    return { width: w, height: Math.max(16, h) };
  }

  const h = ASPECT_RATIO_BASELINE;
  const w = Math.round((h * ratio.w) / ratio.h / 16) * 16;
  return { width: Math.max(16, w), height: h };
}

const RATIO_OPTIONS = ASPECT_RATIOS.map((ratio, index) => {
  const size = computeSize(index);
  return {
    value: `ratio-${index}`,
    label: ratio.label,
    size: `${size.width}x${size.height}`,
  };
});

function selectValueForSize(size: string) {
  if (size === "auto") return "auto";
  return RATIO_OPTIONS.find((option) => option.size === size)?.value ?? "custom";
}

export function AspectRatioSelect({ value, onChange }: { value: string; onChange: (size: string) => void }) {
  const selectValue = selectValueForSize(value);
  return (
    <Select
      value={selectValue}
      onValueChange={(nextValue) => {
        if (nextValue === "auto") {
          onChange("auto");
          return;
        }
        const option = RATIO_OPTIONS.find((item) => item.value === nextValue);
        if (option) onChange(option.size);
      }}
    >
      <SelectTrigger className="h-9 w-full rounded-full border-white/70 bg-white/80 text-xs font-medium text-stone-700 shadow-none sm:w-[132px]">
        <Crop className="mr-1 size-3.5 shrink-0 text-stone-500" />
        <SelectValue placeholder="宽高比" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">自动</SelectItem>
        {RATIO_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {selectValue === "custom" ? <SelectItem value="custom">{value}</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}
