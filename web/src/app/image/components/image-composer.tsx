"use client";

import { ArrowUp, ImagePlus, LoaderCircle, Pen, Sparkles, X } from "lucide-react";
import { useMemo, useState, type ClipboardEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ImageModel, QuickPromptConfig } from "@/lib/api";
import type { ImageConversationMode } from "@/store/image-conversations";

import { AspectRatioSelect } from "./size-selector";

type ImageComposerProps = {
  mode: ImageConversationMode;
  model: ImageModel;
  prompt: string;
  imageCount: string;
  size: string;
  outputFormat: string;
  availableQuota: string;
  hasAnyGenerating: boolean;
  generatingCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  quickPrompts: QuickPromptConfig[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onModeChange: (value: ImageConversationMode) => void;
  onModelChange: (value: ImageModel) => void;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onSizeChange: (value: string) => void;
  onOutputFormatChange: (value: string) => void;
  onQuickPromptSelect: (content: string) => void;
  onOptimizePrompt: () => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
  onOpenMaskEditor: (index: number) => void;
  isOptimizingPrompt: boolean;
};

const formatOptions = ["png", "jpeg", "webp"];
const modelOptions: Array<{ value: ImageModel; label: string }> = [
  { value: "gpt-image-2", label: "gpt-image-2" },
  { value: "grok-imagine-image", label: "grok-imagine-image" },
];

export function ImageComposer({
  mode,
  model,
  prompt,
  imageCount,
  size,
  outputFormat,
  availableQuota,
  hasAnyGenerating,
  generatingCount,
  referenceImages,
  quickPrompts,
  textareaRef,
  fileInputRef,
  onModeChange,
  onModelChange,
  onPromptChange,
  onImageCountChange,
  onSizeChange,
  onOutputFormatChange,
  onQuickPromptSelect,
  onOptimizePrompt,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
  onOpenMaskEditor,
  isOptimizingPrompt,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (mode !== "edit") return;
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="glass-panel section-shell w-full overflow-hidden rounded-[20px] border border-white/60 shadow-[0_28px_90px_-54px_rgba(74,48,27,0.36)] sm:rounded-[30px]">
      {mode === "edit" && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />
      )}

      <div className="border-b border-white/55 px-3 py-2.5 sm:px-5 sm:py-3">
        <div className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-2">
          <ModeButton active={mode === "generate"} onClick={() => onModeChange("generate")}>文生图</ModeButton>
          <ModeButton active={mode === "edit"} onClick={() => onModeChange("edit")}>编辑图</ModeButton>
          <div className="rounded-full bg-white/70 px-2.5 py-2 text-center text-xs font-medium text-stone-600 sm:px-3 sm:text-left">
            积分 {availableQuota} · 每张图消耗 1 积分
          </div>
          {hasAnyGenerating ? (
            <div className="col-span-3 inline-flex items-center justify-center gap-2 rounded-full bg-amber-100 px-3 py-2 text-xs font-medium text-amber-800 sm:col-span-1">
              <LoaderCircle className="size-3.5 animate-spin" />
              队列 {generatingCount}
            </div>
          ) : null}
        </div>
      </div>

      <div className="px-2.5 py-2.5 sm:px-5 sm:py-4">
        {mode === "edit" && referenceImages.length > 0 ? (
          <div className="mb-4">
            <div className="mb-3 text-sm font-medium text-stone-700">参考图</div>
            <div className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap sm:gap-3">
              {referenceImages.map((image, index) => (
                <div key={`${image.name}-${index}`} className="group relative aspect-square w-full sm:size-20">
                  <button
                    type="button"
                    onClick={() => {
                      setLightboxIndex(index);
                      setLightboxOpen(true);
                    }}
                    className="h-full w-full overflow-hidden rounded-[18px] border border-white/70 bg-white/70 transition hover:-translate-y-0.5 hover:border-stone-300 sm:rounded-[22px]"
                  >
                    <img src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="h-full w-full object-cover" />
                  </button>
                  {index === 0 ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenMaskEditor(index);
                      }}
                      className="absolute -left-1 -top-1 inline-flex size-7 items-center justify-center rounded-full bg-amber-400 text-white opacity-0 shadow-sm transition group-hover:opacity-100 hover:bg-amber-500"
                      title="遮罩编辑"
                    >
                      <Pen className="size-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveReferenceImage(index);
                    }}
                    className="absolute -right-1 -top-1 inline-flex size-7 items-center justify-center rounded-full bg-white text-stone-500 opacity-0 shadow-sm transition group-hover:opacity-100 hover:text-stone-900"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="relative cursor-text rounded-[18px] border border-white/60 bg-white/60 p-2 sm:rounded-[28px] sm:p-3" onClick={() => textareaRef.current?.focus()}>
          <ImageLightbox
            images={lightboxImages}
            currentIndex={lightboxIndex}
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            onIndexChange={setLightboxIndex}
          />

          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onPaste={handleTextareaPaste}
            placeholder={mode === "edit" ? "描述你希望如何修改这张参考图，也可以直接粘贴图片" : "输入你想要生成的画面、镜头、氛围、材质或风格"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSubmit();
              }
            }}
            className="min-h-[72px] resize-none rounded-[16px] border-0 bg-transparent px-2.5 py-2 text-[14px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[150px] sm:rounded-[24px] sm:px-3 sm:py-2.5 sm:leading-7"
          />

          <div className="mt-2 flex flex-col gap-2 border-t border-stone-200/70 pt-2 sm:mt-3 sm:gap-3 sm:pt-3">
            <div className="flex flex-col gap-1.5 sm:gap-3">
              <div className="grid min-w-0 grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-2">
                {mode === "edit" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="col-span-2 h-9 rounded-full border-white/70 bg-white/80 px-3 text-xs font-medium text-stone-700 shadow-none sm:col-span-1"
                    onClick={onPickReferenceImage}
                  >
                    <ImagePlus className="size-3.5" />
                    {referenceImages.length > 0 ? "继续添加" : "上传参考图"}
                  </Button>
                ) : null}

                <ImageModelSelect value={model} onChange={onModelChange} />

                <AspectRatioSelect value={size} onChange={onSizeChange} />

                <OutputFormatSelect value={outputFormat} onChange={onOutputFormatChange} />

                <div className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-2 py-1.5 sm:gap-2 sm:px-3">
                  <span className="text-xs font-medium text-stone-600">张数</span>
                  <Input
                    type="number"
                    min="1"
                    max="10"
                    value={imageCount}
                    onChange={(event) => onImageCountChange(event.target.value)}
                    className="h-7 w-[28px] border-0 bg-transparent px-0 text-center text-xs font-semibold text-stone-800 shadow-none focus-visible:ring-0 sm:w-[52px]"
                  />
                </div>

                {mode === "edit" ? (
                  <QuickPromptSelect prompts={quickPrompts} onSelect={onQuickPromptSelect} />
                ) : null}

                <div className="col-span-2 grid grid-cols-2 gap-1.5 sm:col-span-1 sm:flex sm:gap-2">
                  <button
                    type="button"
                    onClick={() => void onOptimizePrompt()}
                    disabled={!prompt.trim() || isOptimizingPrompt}
                    className="inline-flex h-9 w-full items-center justify-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-medium text-amber-900 shadow-none transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400 sm:w-auto sm:gap-2 sm:px-4 sm:text-sm"
                  >
                    {isOptimizingPrompt ? <LoaderCircle className="size-3.5 animate-spin sm:size-4" /> : <Sparkles className="size-3.5 sm:size-4" />}
                    <span className="sm:hidden">优化</span>
                    <span className="hidden sm:inline">一键AI优化提示词</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={!prompt.trim() || (mode === "edit" && referenceImages.length === 0)}
                    className="inline-flex h-9 w-full items-center justify-center gap-1 rounded-full bg-stone-950 px-2.5 text-xs font-medium text-white shadow-[0_16px_28px_-18px_rgba(28,25,23,0.86)] transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:w-auto sm:gap-2 sm:px-5 sm:text-sm"
                  >
                    <ArrowUp className="size-3.5 sm:size-4" />
                    <span className="sm:hidden">生成</span>
                    <span className="hidden sm:inline">开始生成</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageModelSelect({
  value,
  onChange,
}: {
  value: ImageModel;
  onChange: (value: ImageModel) => void;
}) {
  const availableOptions = modelOptions;

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        const option = availableOptions.find((item) => item.value === nextValue);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger className="col-span-2 h-9 w-full rounded-full border-white/70 bg-white/80 text-xs font-medium text-stone-700 shadow-none sm:col-span-1 sm:w-[176px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {availableOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function QuickPromptSelect({ prompts, onSelect }: { prompts: QuickPromptConfig[]; onSelect: (content: string) => void }) {
  return (
    <Select
      value=""
      onValueChange={(value) => {
        const index = Number(value);
        const item = Number.isInteger(index) ? prompts[index] : null;
        if (item?.content) onSelect(item.content);
      }}
    >
      <SelectTrigger className="col-span-2 h-9 w-full rounded-full border-white/70 bg-white/80 text-xs font-medium text-stone-700 shadow-none sm:col-span-1 sm:w-[132px]">
        <SelectValue placeholder="快捷提示词" />
      </SelectTrigger>
      <SelectContent>
        {prompts.length > 0 ? (
          prompts.map((prompt, index) => (
            <SelectItem key={`${prompt.label}-${index}`} value={String(index)}>
              {prompt.label || `快捷提示词 ${index + 1}`}
            </SelectItem>
          ))
        ) : (
          <SelectItem value="__empty__" disabled>
            暂无快捷提示词
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function OutputFormatSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-full rounded-full border-white/70 bg-white/80 text-xs font-medium uppercase text-stone-700 shadow-none sm:w-[96px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {formatOptions.map((format) => (
          <SelectItem key={format} value={format}>
            {format.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModeButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3.5 py-2 text-xs font-medium transition",
        active
          ? "border-stone-950 bg-stone-950 text-white"
          : "border-white/70 bg-white/70 text-stone-600 hover:border-stone-300 hover:bg-white/85",
      )}
    >
      {children}
    </button>
  );
}
