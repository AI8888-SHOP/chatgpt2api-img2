"use client";

import { Clock3, FileImage, Images, LoaderCircle, PencilLine, RotateCcw, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { getStoredImageSrc, type ImageConversation, type StoredImage } from "@/store/image-conversations";

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  isSelectedGenerating: boolean;
  openLightbox: (imageId: string) => void;
  onReuseConversation: (conversation: ImageConversation) => void;
  onUseResultAsReference: (image: StoredImage, index: number) => void | Promise<void>;
  onSplitAsPsd: (image: StoredImage, index: number) => void | Promise<void>;
  onResumeImageJob: (conversationId: string, imageId: string, jobId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

export function ImageResults({
  selectedConversation,
  isSelectedGenerating,
  openLightbox,
  onReuseConversation,
  onUseResultAsReference,
  onSplitAsPsd,
  onResumeImageJob,
  formatConversationTime,
}: ImageResultsProps) {
  const [referenceLightboxOpen, setReferenceLightboxOpen] = useState(false);
  const [referenceLightboxIndex, setReferenceLightboxIndex] = useState(0);

  const referenceLightboxImages = useMemo(
    () =>
      (selectedConversation?.referenceImages ?? []).map((image, index) => ({
        id: `${image.name}-${index}`,
        src: image.dataUrl,
      })),
    [selectedConversation?.referenceImages],
  );

  if (!selectedConversation) {
    return (
      <div className="flex min-h-0 items-center justify-center px-3 py-4 text-center sm:min-h-[420px] sm:px-4 sm:py-8">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-1.5 text-[11px] font-medium text-stone-500 shadow-sm dark:border-cyan-100/10 dark:bg-slate-900/72 dark:text-slate-300">
            <Sparkles className="size-4" />
            Image Workspace
          </div>
          <h1
            className="mt-3 text-lg font-semibold tracking-tight text-stone-950 sm:mt-6 sm:text-5xl dark:text-slate-100"
            style={{ fontFamily: '"Iowan Old Style","Palatino Linotype","Book Antiqua",serif' }}
          >
            先整理提示词，再沉淀一条可回看的图像会话。
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-stone-500 sm:mt-4 sm:text-[15px] sm:leading-7 dark:text-slate-400">
            左侧保留历史记录，右侧专注看当前结果。开发端优先验证工作台的节奏和可读性，再决定是否上线到 3020。
          </p>

          <div className="mt-4 hidden gap-3 text-left sm:grid md:grid-cols-3">
            <IntroCard title="Prompt" text="先把目标画面、镜头、风格和材质说明白。" />
            <IntroCard title="Reference" text="编辑模式下直接挂参考图和遮罩，避免上下文丢失。" />
            <IntroCard title="Result" text="每次出图都以会话形式沉淀，便于回看和对比。" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-5 sm:gap-6">
      <ImageLightbox
        images={referenceLightboxImages}
        currentIndex={referenceLightboxIndex}
        open={referenceLightboxOpen}
        onOpenChange={setReferenceLightboxOpen}
        onIndexChange={setReferenceLightboxIndex}
      />

      <section className="flex justify-end">
        <div className="flex w-full flex-col items-end gap-3 sm:max-w-[86%] 2xl:max-w-[78%]">
          {selectedConversation.referenceImages?.length ? (
            <div className="flex flex-wrap justify-end gap-2.5">
              {selectedConversation.referenceImages.map((image, index) => (
                <button
                  key={`${image.name}-${index}`}
                  type="button"
                  onClick={() => {
                    setReferenceLightboxIndex(index);
                    setReferenceLightboxOpen(true);
                  }}
                  className="group relative w-[126px] overflow-hidden rounded-[20px] border border-stone-200 bg-white shadow-sm transition hover:border-stone-300 dark:border-slate-700/80 dark:bg-slate-900/78 dark:hover:border-cyan-300/30"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name || `参考图 ${index + 1}`}
                    className="block h-24 w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                  />
                  <div className="border-t border-stone-100 px-3 py-2 text-left text-[11px] text-stone-500 dark:border-slate-700/70 dark:text-slate-400">
                    {image.name || `参考图 ${index + 1}`}
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex max-w-full flex-col items-end gap-3">
            <div className="w-fit max-w-full whitespace-pre-wrap break-words rounded-[22px] bg-[#f2f2f1] px-4 py-3 text-[14px] leading-7 text-stone-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] sm:rounded-[28px] sm:px-5 sm:py-4 sm:text-[15px] dark:bg-slate-800/84 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              {selectedConversation.prompt || "无额外提示词"}
            </div>

            <button
              type="button"
              onClick={() => onReuseConversation(selectedConversation)}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-stone-950 px-4 text-xs font-medium text-white shadow-[0_16px_28px_-18px_rgba(28,25,23,0.8)] transition hover:bg-stone-800 dark:bg-cyan-300 dark:text-slate-950 dark:hover:bg-cyan-200"
            >
              <RotateCcw className="size-3.5" />
              复用并继续对话
            </button>

            <div className="flex flex-wrap justify-end gap-1.5 text-xs font-medium text-stone-500 sm:gap-2">
              <MetaChip>{selectedConversation.mode === "edit" ? "编辑图" : "文生图"}</MetaChip>
              <MetaChip>{selectedConversation.model}</MetaChip>
              <MetaChip>{selectedConversation.count} 张</MetaChip>
              <MetaChip icon={<Clock3 className="size-3.5" />}>{formatConversationTime(selectedConversation.createdAt)}</MetaChip>
              <MetaChip icon={<Images className="size-3.5" />}>{selectedConversation.images.length} / {selectedConversation.count}</MetaChip>
              {isSelectedGenerating ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1.5 text-amber-700 dark:bg-amber-400/12 dark:text-amber-200">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  处理中
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="flex justify-start">
        <div className="w-full rounded-[22px] border border-stone-200 bg-white px-3 py-4 shadow-[0_10px_34px_rgba(15,23,42,0.05)] sm:max-w-[96%] sm:rounded-[28px] sm:px-5 sm:py-5 dark:border-slate-700/75 dark:bg-slate-900/72 dark:shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500 dark:text-cyan-200/70">Assistant</div>
              <div className="mt-1 text-sm font-medium text-stone-900 dark:text-slate-100">图像结果回复</div>
              <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-slate-400">
                {selectedConversation.status === "error"
                  ? "这轮请求已返回部分结果，同时包含失败信息。"
                  : isSelectedGenerating
                    ? "我正在继续补齐这轮结果，完成后会自动刷新到当前会话。"
                    : "这轮请求已经完成，下面是当前会话返回的图像结果。"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-medium text-stone-500 sm:justify-end">
              <MetaChip>{selectedConversation.mode === "edit" ? "编辑图" : "文生图"}</MetaChip>
              <MetaChip icon={<Images className="size-3.5" />}>{selectedConversation.count} 张输出</MetaChip>
            </div>
          </div>

          {selectedConversation.status === "error" && selectedConversation.images.length === 0 ? (
            <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700 dark:border-rose-300/25 dark:bg-rose-500/10 dark:text-rose-200">
              {selectedConversation.error || "生成失败"}
            </div>
          ) : null}

          {selectedConversation.images.length > 0 ? (
            <section className="columns-1 gap-3 space-y-3 pt-1 sm:columns-2 sm:gap-4 sm:space-y-4 2xl:columns-3">
              {selectedConversation.images.map((image, index) => (
                <div key={image.id} className="break-inside-avoid overflow-hidden rounded-[24px]">
                  <ImageResultCard
                    image={image}
                    index={index}
                    conversationId={selectedConversation.id}
                    onOpen={openLightbox}
                    onUseAsReference={onUseResultAsReference}
                    onSplitAsPsd={onSplitAsPsd}
                    onResumeImageJob={onResumeImageJob}
                  />
                </div>
              ))}
            </section>
          ) : null}

          {selectedConversation.status === "error" && selectedConversation.images.length > 0 ? (
            <div className="mt-4 rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-800 dark:border-amber-300/25 dark:bg-amber-400/10 dark:text-amber-200">
              {selectedConversation.error}
            </div>
          ) : null}
        </div>
      </section>

      <section className="flex justify-start">
        <div className="rounded-full bg-stone-100 px-3 py-1.5 text-[11px] font-medium text-stone-500 dark:bg-slate-800/80 dark:text-slate-400">
          本轮创建于 {formatConversationTime(selectedConversation.createdAt)}
        </div>
      </section>
    </div>
  );
}

function IntroCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-[24px] border border-stone-200 bg-white p-4 shadow-sm dark:border-slate-700/75 dark:bg-slate-900/72">
      <div className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500 dark:text-cyan-200/70">{title}</div>
      <div className="mt-2 text-sm leading-7 text-stone-700 dark:text-slate-300">{text}</div>
    </div>
  );
}

function MetaChip({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 shadow-sm dark:bg-slate-800/78 dark:text-slate-300 dark:ring-1 dark:ring-white/6">
      {icon}
      {children}
    </span>
  );
}

function ImageResultCard({
  image,
  index,
  conversationId,
  onOpen,
  onUseAsReference,
  onSplitAsPsd,
  onResumeImageJob,
}: {
  image: StoredImage;
  index: number;
  conversationId: string;
  onOpen: (imageId: string) => void;
  onUseAsReference: (image: StoredImage, index: number) => void | Promise<void>;
  onSplitAsPsd: (image: StoredImage, index: number) => void | Promise<void>;
  onResumeImageJob: (conversationId: string, imageId: string, jobId: string) => void | Promise<void>;
}) {
  const imageSrc = getStoredImageSrc(image);

  if (image.status === "success" && imageSrc) {
    return (
      <div className="group relative overflow-hidden rounded-[24px] border border-stone-200 bg-white text-left shadow-[0_10px_34px_rgba(15,23,42,0.06)] transition hover:border-stone-300 dark:border-slate-700/75 dark:bg-slate-900/72 dark:hover:border-cyan-300/30">
        <button type="button" onClick={() => onOpen(image.id)} className="block w-full cursor-zoom-in text-left" aria-label={`查看结果图 ${index + 1}`}>
          <img
            src={imageSrc}
            alt={`Generated result ${index + 1}`}
            className="block h-auto w-full transition duration-200 group-hover:scale-[1.01] group-hover:brightness-[0.97]"
          />
        </button>
        <div className="absolute right-3 top-3 flex flex-col gap-2 opacity-100 transition sm:flex-row sm:opacity-0 sm:group-hover:opacity-100">
          <button
            type="button"
            onClick={() => void onUseAsReference(image, index)}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-white/92 px-3 text-xs font-medium text-stone-800 shadow-sm transition hover:bg-white dark:bg-slate-950/84 dark:text-slate-100 dark:hover:bg-slate-900"
          >
            <PencilLine className="size-3.5" />
            作为参考图
          </button>
          <button
            type="button"
            onClick={() => void onSplitAsPsd(image, index)}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-stone-950/92 px-3 text-xs font-medium text-white shadow-sm transition hover:bg-stone-950 dark:bg-cyan-300/92 dark:text-slate-950 dark:hover:bg-cyan-200"
          >
            <FileImage className="size-3.5" />
            PSD 拆分
          </button>
        </div>
      </div>
    );
  }

  if (image.status === "error") {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-[24px] border border-rose-200 bg-rose-50 px-6 py-8 text-center text-sm leading-7 text-rose-700 dark:border-rose-300/25 dark:bg-rose-500/10 dark:text-rose-200">
        <div>
          <p>{image.error || "生成失败"}</p>
          {image.progressText ? <p className="mt-1 text-xs opacity-80">{image.progressText}</p> : null}
        </div>
        {image.canResume && image.jobId ? (
          <button
            type="button"
            onClick={() => void onResumeImageJob(conversationId, image.id, image.jobId as string)}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-rose-700 px-4 text-xs font-medium text-white shadow-sm transition hover:bg-rose-800 dark:bg-rose-200 dark:text-rose-950 dark:hover:bg-rose-100"
          >
            <LoaderCircle className="size-3.5" />
            继续等待
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-[24px] border border-stone-200 bg-[#f8f8f7] px-6 py-8 text-center text-stone-500 dark:border-slate-700/75 dark:bg-slate-900/60 dark:text-slate-400">
      <div className="flex size-12 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-800 dark:text-cyan-200">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
      <div>
        <p className="text-sm font-medium text-stone-700 dark:text-slate-200">正在生成图片...</p>
        <p className="mt-1 text-xs text-stone-500 dark:text-slate-400">{image.progressText || "结果完成后会自动更新到当前会话。"}</p>
      </div>
    </div>
  );
}
