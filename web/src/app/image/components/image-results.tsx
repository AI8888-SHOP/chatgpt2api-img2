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
      <div className="flex min-h-0 items-center justify-center px-3 py-4 text-center sm:px-4 sm:py-8">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-1.5 text-[11px] font-medium text-stone-500 shadow-sm dark:border-cyan-100/10 dark:bg-slate-900/72 dark:text-slate-300">
            <Sparkles className="size-4" />
            Image Workspace
          </div>
          <h2
            className="mt-3 text-lg font-semibold tracking-tight text-stone-950 sm:mt-6 sm:text-3xl dark:text-slate-100"
          >
            把想法变成图像
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-stone-500 sm:mt-4 sm:text-[15px] sm:leading-7 dark:text-slate-400">
            输入画面描述开始生成，或上传参考图进行编辑。完成的图片会保存在历史记录中。
          </p>


        </div>
      </div>
    );
  }

  return (
    <div className="studio-turn flex w-full flex-col gap-4">
      <ImageLightbox
        images={referenceLightboxImages}
        currentIndex={referenceLightboxIndex}
        open={referenceLightboxOpen}
        onOpenChange={setReferenceLightboxOpen}
        onIndexChange={setReferenceLightboxIndex}
      />

      <section className="studio-turn-prompt flex justify-end">
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
              className="studio-reuse-button"
            >
              <RotateCcw className="size-3.5" />
              复用并继续对话
            </button>

            <div className="studio-result-meta">
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

      <section className="studio-turn-images flex justify-start">
        <div className="studio-result-reply">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Sparkles size={16} className="text-primary" />{isSelectedGenerating ? "图像生成中" : selectedConversation.status === "error" ? "图像结果 · 含失败任务" : "图像已就绪"}<span className="text-xs font-normal text-muted-foreground">· {selectedConversation.images.length} 张</span></div>

          {selectedConversation.status === "error" && selectedConversation.images.length === 0 ? (
            <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700 dark:border-rose-300/25 dark:bg-rose-500/10 dark:text-rose-200">
              {selectedConversation.error || "生成失败"}
            </div>
          ) : null}

          {selectedConversation.images.length > 0 ? (
            <section className="studio-image-grid" data-count={selectedConversation.images.length}>
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

function MetaChip({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
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
      <div className="studio-image-card group">
        <button type="button" onClick={() => onOpen(image.id)} className="block w-full cursor-zoom-in text-left" aria-label={`查看结果图 ${index + 1}`}>
          <img
            data-image-result
            src={imageSrc}
            alt={`Generated result ${index + 1}`}
            className="block h-auto w-full transition duration-200 group-hover:scale-[1.01] group-hover:brightness-[0.97]"
          />
        </button>
        <div className="studio-image-actions">
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
