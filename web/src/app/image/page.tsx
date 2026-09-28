"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { toast } from "sonner";
import { History, Plus } from "lucide-react";
import { useDesign } from "@/components/design-provider";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageResults } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { MaskEditor } from "@/app/image/components/mask-editor";
import { ImageLightbox } from "@/components/image-lightbox";
import { SideDrawer } from "@/components/ui/side-drawer";
import {
  createImageEditJob,
  createImageGenerationJob,
  fetchImageJob,
  fetchImageJobs,
  fetchPublicAppConfig,
  fetchUserKeyInfo,
  resumeImageJobPoll,
  type ImageGenParams,
  type ImageJobResult,
  type ImageJobStatus,
  type ImageModel,
  type QuickPromptConfig,
  optimizeImagePrompt,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  deleteImageConversation,
  getStoredImageSrc,
  getImageThreadId,
  getImageThreadTurns,
  getImageThreadSummaries,
  listImageConversations,
  saveImageConversation,
  type ImageConversation,
  type ImageConversationMode,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2";
const PSD_REFERENCE_TRANSFER_KEY = "editable-files:incoming-psd-reference";

function normalizeImageModel(value: unknown): ImageModel {
  return value === "grok-imagine-image" ? value : DEFAULT_IMAGE_MODEL;
}

function normalizeImageModelForMode(value: unknown): ImageModel {
  return normalizeImageModel(value);
}

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 5) return trimmed;
  return `${trimmed.slice(0, 5)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fallbackConversation(id: string, status: ImageConversation["status"] = "generating"): ImageConversation {
  return {
    id,
    title: "",
    prompt: "",
    model: DEFAULT_IMAGE_MODEL,
    count: 1,
    images: [],
    createdAt: new Date().toISOString(),
    status,
  };
}

function conversationHasRunnableImage(conversation: ImageConversation) {
  return conversation.images.some((image) => image.status === "loading" && image.jobId);
}

function normalizeLoadedConversation(conversation: ImageConversation): ImageConversation {
  if (conversation.status !== "generating") return conversation;
  if (conversationHasRunnableImage(conversation)) return conversation;
  const createdAt = new Date(conversation.createdAt).getTime();
  if (!Number.isNaN(createdAt) && Date.now() - createdAt < 10 * 60 * 1000) return conversation;
  return {
    ...conversation,
    status: "error",
    error: conversation.images.some((image) => image.status === "success") ? conversation.error || "生成已中断" : "页面已刷新，生成已中断",
    images: conversation.images.map((image) =>
      image.status === "loading" ? { ...image, status: "error" as const, error: "页面已刷新，生成已中断" } : image,
    ),
  };
}

async function normalizeConversationHistory(items: ImageConversation[]) {
  const hydrated = await Promise.all(items.map(hydrateConversationJobs));
  const normalized = hydrated.map(normalizeLoadedConversation);
  await Promise.all(normalized.filter((item, index) => item !== items[index]).map((item) => saveImageConversation(item)));
  return normalized;
}

async function hydrateConversationJobs(conversation: ImageConversation): Promise<ImageConversation> {
  if (conversation.status !== "generating") return conversation;
  const missingJobImages = conversation.images.filter((image) => image.status === "loading" && !image.jobId);
  if (!missingJobImages.length) return conversation;

  try {
    const data = await fetchImageJobs({ client_conversation_id: conversation.id, limit: 50 });
    const jobsByImageId = new Map(
      (data.items || [])
        .filter((job) => job.client_image_id)
        .map((job) => [job.client_image_id as string, job]),
    );
    let changed = false;
    const images = conversation.images.map((image) => {
      if (image.status !== "loading" || image.jobId) return image;
      const job = jobsByImageId.get(image.id);
      if (!job) return image;
      changed = true;
      return {
        ...image,
        jobId: job.job_id,
        progress: job.progress,
        progressText: job.progress_text,
        canResume: job.can_resume === true,
        ...(job.status === "error" ? { status: "error" as const, error: job.error || "生成图片失败" } : {}),
        ...(job.status === "success" && job.result?.data?.[0]?.url
          ? { status: "success" as const, url: job.result.data[0].url, progress: "success", progressText: "生成完成", canResume: false }
          : {}),
      };
    });
    if (!changed) return conversation;
    const hasLoading = images.some((image) => image.status === "loading");
    const hasError = images.some((image) => image.status === "error");
    return {
      ...conversation,
      images,
      status: hasLoading ? "generating" : hasError ? "error" : "success",
      error: hasError && !hasLoading ? conversation.error || "部分图片生成失败" : undefined,
    };
  } catch {
    return conversation;
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, filename: string, fallbackType = "image/png"): File {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || fallbackType;
  const binary = atob(data || "");
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
  return new File([array], filename, { type: mime });
}

function referenceImageToFile(image: StoredReferenceImage, index: number): File {
  const filename = image.name || `reference_${index + 1}.png`;
  return dataUrlToFile(image.dataUrl, filename, image.type || "image/png");
}

function extensionFromType(type: string) {
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  return "png";
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForImageJob(
  jobId: string,
  onUpdate?: (job: ImageJobStatus) => void | Promise<void>,
): Promise<ImageJobResult> {
  const startedAt = Date.now();
  const timeoutMs = 30 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const job = await fetchImageJob(jobId);
      await onUpdate?.(job);
      if (job.status === "success" && job.result) return job.result;
      if (job.status === "error") {
        const error = new Error(job.error || "生成图片失败");
        Object.assign(error, { job });
        throw error;
      }
    } catch (error) {
      if ((error as Error & { job?: ImageJobStatus }).job?.status === "error") throw error;
    }
    await sleep(3000);
  }

  throw new Error("生成任务等待超时");
}

async function resultImageToReference(src: string, index: number): Promise<StoredReferenceImage> {
  if (src.startsWith("data:")) {
    const mime = src.match(/^data:(.*?);/)?.[1] || "image/png";
    return { name: `result_${index + 1}.${extensionFromType(mime)}`, type: mime, dataUrl: src };
  }

  const response = await fetch(src);
  if (!response.ok) throw new Error("读取结果图失败");
  const blob = await response.blob();
  const type = blob.type || "image/png";
  const name = `result_${index + 1}.${extensionFromType(type)}`;
  const dataUrl = await readFileAsDataUrl(new File([blob], name, { type }));
  return { name, type, dataUrl };
}

export default function ImagePage() {
  const { variant } = useDesign();
  const [canvasTurnId, setCanvasTurnId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const pendingHistoryScrollRef = useRef(false);
  const resumingConversationIdsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const resultsEndRef = useRef<HTMLDivElement>(null);
  const resultsScrollRef = useRef<HTMLDivElement>(null);
  const promptRevisionRef = useRef(0);
  const optimizingRef = useRef(false);
  const referenceRevisionRef = useRef(0);

  const [imagePrompt, setImagePromptState] = useState("");
  const setImagePrompt = useCallback((value: SetStateAction<string>) => {
    promptRevisionRef.current += 1;
    setImagePromptState(value);
  }, []);
  const [imageCount, setImageCount] = useState("1");
  const [imageMode, setImageMode] = useState<ImageConversationMode>("generate");
  const [imageModel, setImageModel] = useState<ImageModel>(DEFAULT_IMAGE_MODEL);
  const [imageQuality, setImageQuality] = useState("auto");
  const [imageSize, setImageSize] = useState("auto");
  const [imageOutputFormat, setImageOutputFormat] = useState("png");
  const [imageOutputCompression, setImageOutputCompression] = useState(0);
  const [imageModeration, setImageModeration] = useState("auto");
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [continuingThreadId, setContinuingThreadId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [availableQuota, setAvailableQuota] = useState("加载中");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [maskEditorImage, setMaskEditorImage] = useState<string | null>(null);
  const [maskEditorIndex, setMaskEditorIndex] = useState<number>(-1);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [isWideLayout, setIsWideLayout] = useState(false);
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false);
  const [quickPrompts, setQuickPrompts] = useState<QuickPromptConfig[]>([]);

  const selectedTurns = useMemo(
    () => selectedConversationId ? getImageThreadTurns(conversations, selectedConversationId) : [],
    [conversations, selectedConversationId],
  );
  const threadSummaries = useMemo(() => getImageThreadSummaries(conversations), [conversations]);
  const generatingThreadIds = useMemo(() => new Set(
    conversations.filter((item) => generatingIds.has(item.id)).map(getImageThreadId),
  ), [conversations, generatingIds]);
  const selectedConversation = selectedTurns[selectedTurns.length - 1] ?? null;
  const parsedCount = useMemo(() => Math.max(1, Math.min(10, Math.trunc(Number(imageCount) || 1))), [imageCount]);
  const hasAnyGenerating = generatingIds.size > 0;

  useEffect(() => {
    const panel = resultsScrollRef.current;
    if (panel && selectedTurns.length) panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
  }, [selectedConversationId, selectedTurns.length, variant]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handleOpenHistory = () => {
      window.sessionStorage.removeItem("image:open-history");
      pendingHistoryScrollRef.current = true;
      if (isWideLayout && variant === "a") {
        setHistoryCollapsed(false);
      } else {
        setMobileHistoryOpen(true);
      }
    };

    window.addEventListener("image:open-history", handleOpenHistory);
    if (window.sessionStorage.getItem("image:open-history") === "1") {
      window.sessionStorage.removeItem("image:open-history");
      handleOpenHistory();
    }
    return () => window.removeEventListener("image:open-history", handleOpenHistory);
  }, [isWideLayout, variant]);

  useEffect(() => {
    if (!pendingHistoryScrollRef.current) return;
    if (!isWideLayout) {
      pendingHistoryScrollRef.current = false;
      return;
    }
    if (isWideLayout && historyCollapsed) return;

    pendingHistoryScrollRef.current = false;
    requestAnimationFrame(() => {
      historyPanelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [historyCollapsed, isWideLayout, mobileHistoryOpen]);

  const addGeneratingId = useCallback((id: string) => {
    setGeneratingIds((prev) => new Set(prev).add(id));
  }, []);

  const removeGeneratingId = useCallback((id: string) => {
    setGeneratingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const lightboxImages = useMemo(
    () =>
      selectedTurns.flatMap((turn) => turn.images)
        .map((img) => ({ id: img.id, src: getStoredImageSrc(img) }))
        .filter((img): img is { id: string; src: string } => !!img.src),
    [selectedTurns],
  );

  const openLightbox = useCallback(
    (imageId: string) => {
      const idx = lightboxImages.findIndex((img) => img.id === imageId);
      if (idx >= 0) {
        setLightboxIndex(idx);
        setLightboxOpen(true);
      }
    },
    [lightboxImages],
  );

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const items = await listImageConversations();
        const normalizedItems = await normalizeConversationHistory(items);
        if (!cancelled) setConversations(normalizedItems);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取会话记录失败");
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadQuickPrompts = async () => {
      try {
        const data = await fetchPublicAppConfig();
        const prompts = Array.isArray(data.quick_prompts) ? data.quick_prompts : [];
        if (!cancelled) {
          setQuickPrompts(
            prompts
              .map((item, index) => ({
                label: String(item.label || `快捷提示词 ${index + 1}`).trim(),
                content: String(item.content || "").trim(),
              }))
              .filter((item) => item.content),
          );
        }
      } catch {
        if (!cancelled) setQuickPrompts([]);
      }
    };

    void loadQuickPrompts();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQuota = useCallback(async () => {
    try {
      const data = await fetchUserKeyInfo();
      setAvailableQuota(data.remaining === -1 ? "无限" : `${data.remaining}`);
    } catch {
      setAvailableQuota("未知");
    }
  }, []);

  useEffect(() => {
    void loadQuota();
  }, [loadQuota]);

  useEffect(() => {
    const syncWideLayout = () => {
      setIsWideLayout(window.innerWidth >= 1024);
    };

    syncWideLayout();
    window.addEventListener("resize", syncWideLayout);
    return () => window.removeEventListener("resize", syncWideLayout);
  }, []);

  const persistConversation = useCallback(async (conversation: ImageConversation) => {
    await saveImageConversation(conversation);
    conversationsRef.current = [conversation, ...conversationsRef.current.filter((item) => item.id !== conversation.id)];
    setConversations((prev) => {
      const idx = prev.findIndex((item) => item.id === conversation.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = conversation;
        return next;
      }
      return [conversation, ...prev];
    });
  }, []);

  const updateConversation = useCallback(
    async (id: string, updater: (current: ImageConversation | undefined) => ImageConversation) => {
      const current = conversationsRef.current.find((item) => item.id === id);
      const updated = updater(current);
      const idx = conversationsRef.current.findIndex((item) => item.id === id);
      conversationsRef.current =
        idx >= 0
          ? conversationsRef.current.map((item) => (item.id === id ? updated : item))
          : [updated, ...conversationsRef.current];

      setConversations((prev) => {
        const idx = prev.findIndex((item) => item.id === id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        return [updated, ...prev];
      });

      await saveImageConversation(updated);
    },
    [],
  );

  const waitForConversationImageJob = useCallback(
    async (conversationId: string, imageId: string, jobId: string, fallback?: ImageConversation): Promise<StoredImage> => {
      const data = await waitForImageJob(jobId, async (jobStatus) => {
        await updateConversation(conversationId, (current) => ({
          ...(current ?? fallback ?? fallbackConversation(conversationId)),
          status: "generating",
          error: undefined,
          images: (current?.images ?? fallback?.images ?? []).map((image) =>
            image.id === imageId
              ? {
                  ...image,
                  status: "loading" as const,
                  jobId,
                  progress: jobStatus.progress,
                  progressText: jobStatus.progress_text,
                  canResume: jobStatus.can_resume === true,
                }
              : image,
          ),
        }));
      });
      const first = data.data?.[0];
      if (!first?.url) throw new Error("没有返回图片地址");

      const nextImage: StoredImage = {
        id: imageId,
        status: "success",
        url: first.url,
        jobId,
        progress: "success",
        progressText: "生成完成",
        canResume: false,
      };
      await updateConversation(conversationId, (current) => {
        const images = (current?.images ?? fallback?.images ?? []).map((image) => (image.id === imageId ? nextImage : image));
        const hasLoading = images.some((image) => image.status === "loading");
        const hasError = images.some((image) => image.status === "error");
        return {
          ...(current ?? fallback ?? fallbackConversation(conversationId)),
          images,
          status: hasLoading ? "generating" : hasError ? "error" : "success",
          error: hasError ? current?.error || fallback?.error : undefined,
        };
      });
      return nextImage;
    },
    [updateConversation],
  );

  useEffect(() => {
    if (isLoadingHistory) return;
    const resumable = conversations.filter(conversationHasRunnableImage);
    if (!resumable.length) return;

    resumable.forEach((conversation) => {
      const conversationId = conversation.id;
      if (generatingIds.has(conversationId) || resumingConversationIdsRef.current.has(conversationId)) return;
      resumingConversationIdsRef.current.add(conversationId);
      addGeneratingId(conversationId);
      void (async () => {
        try {
          const jobs = conversation.images
            .filter((image) => image.status === "loading" && image.jobId)
            .map(async (image) => {
              try {
                return await waitForConversationImageJob(conversationId, image.id, image.jobId as string, conversation);
              } catch (error) {
                const jobStatus = (error as Error & { job?: ImageJobStatus }).job;
                const message = error instanceof Error ? error.message : "生成图片失败";
                const canKeepPolling = Boolean(image.jobId) && jobStatus?.status !== "error";
                await updateConversation(conversationId, (current) => ({
                  ...(current ?? conversation),
                  images: (current?.images ?? conversation.images).map((item) =>
                    item.id === image.id
                      ? {
                          ...item,
                          status: canKeepPolling ? ("loading" as const) : ("error" as const),
                          error: canKeepPolling ? undefined : message,
                          jobId: image.jobId,
                          progress: jobStatus?.progress,
                          progressText: jobStatus?.progress_text,
                          canResume: jobStatus?.can_resume === true,
                        }
                      : item,
                  ),
                }));
                throw error;
              }
            });
          const settled = await Promise.allSettled(jobs);
          if (!mountedRef.current) return;
          const successCount = settled.filter((item) => item.status === "fulfilled").length;
          const failedCount = settled.length - successCount;
          await updateConversation(conversationId, (current) => {
            const images = current?.images ?? conversation.images;
            const hasLoading = images.some((image) => image.status === "loading");
            const hasError = images.some((image) => image.status === "error");
            return {
              ...(current ?? conversation),
              status: hasLoading ? "generating" : hasError ? "error" : "success",
              error: hasError ? (failedCount > 0 ? `其中 ${failedCount} 张生成失败` : current?.error) : undefined,
            };
          });
          if (successCount > 0) await loadQuota();
        } finally {
          resumingConversationIdsRef.current.delete(conversationId);
          if (mountedRef.current) removeGeneratingId(conversationId);
        }
      })();
    });
  }, [
    addGeneratingId,
    conversations,
    generatingIds,
    isLoadingHistory,
    loadQuota,
    removeGeneratingId,
    updateConversation,
    waitForConversationImageJob,
  ]);

  const resetComposer = useCallback(() => {
    referenceRevisionRef.current += 1;
    setImagePrompt("");
    setReferenceImageFiles([]);
    setReferenceImages([]);
    setImageCount("1");
  }, []);

  const handleNewConversation = useCallback(() => {
    setContinuingThreadId(null);
    setSelectedConversationId(null);
    resetComposer();
    setImageMode("generate");
    setMaskEditorImage(null);
    setMaskEditorIndex(-1);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [resetComposer]);

  const handleSelectConversation = useCallback((id: string) => {
    setSelectedConversationId(id);
    setContinuingThreadId(id);
    resetComposer();
    setImageMode("generate");
    setMaskEditorImage(null);
    setMaskEditorIndex(-1);
  }, [resetComposer]);

  const applyReferenceImagesToComposer = useCallback((images: StoredReferenceImage[]) => {
    referenceRevisionRef.current += 1;
    const available = images.filter((image) => image.dataUrl?.startsWith("data:image/"));
    setReferenceImages(available);
    setReferenceImageFiles(available.map(referenceImageToFile));
    if (available.length !== images.length) toast.info("部分参考图未保存在此设备，请重新上传后继续");
  }, []);

  const handleReuseConversation = useCallback(
    (conversation: ImageConversation) => {
      const threadId = getImageThreadId(conversation);
      setSelectedConversationId(threadId);
      setContinuingThreadId(threadId);
      const mode = conversation.mode === "edit" ? "edit" : "generate";
      setImagePrompt(conversation.prompt);
      setImageMode(mode);
      setImageModel(normalizeImageModelForMode(conversation.model));
      setImageCount(String(Math.max(1, Math.min(10, conversation.count || 1))));
      setImageQuality(conversation.generationSettings?.quality || "auto");
      setImageSize(conversation.generationSettings?.size || "auto");
      setImageOutputFormat(conversation.generationSettings?.outputFormat || "png");
      setImageOutputCompression(conversation.generationSettings?.outputCompression ?? 0);
      setImageModeration(conversation.generationSettings?.moderation || "auto");
      applyReferenceImagesToComposer(mode === "edit" ? [...(conversation.referenceImages || [])] : []);
      toast.success("已复用输入，提交后将在原对话中继续");
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [applyReferenceImagesToComposer],
  );

  const handleUseResultAsReference = useCallback(
    async (image: StoredImage, index: number, sourceConversation: ImageConversation | null = selectedConversation) => {
      const src = getStoredImageSrc(image);
      if (!src) return;
      try {
        const referenceImage = await resultImageToReference(src, index);
        if (sourceConversation) {
          const threadId = getImageThreadId(sourceConversation);
          setSelectedConversationId(threadId);
          setContinuingThreadId(threadId);
        }
        setImageMode("edit");
        applyReferenceImagesToComposer([referenceImage]);
        setImagePrompt(sourceConversation?.prompt || "");
        setImageModel(normalizeImageModel(sourceConversation?.model));
        setImageCount("1");
        setImageQuality(sourceConversation?.generationSettings?.quality || "auto");
        setImageSize(sourceConversation?.generationSettings?.size || "auto");
        setImageOutputFormat(sourceConversation?.generationSettings?.outputFormat || "png");
        setImageOutputCompression(sourceConversation?.generationSettings?.outputCompression ?? 0);
        setImageModeration(sourceConversation?.generationSettings?.moderation || "auto");
        toast.success("已作为参考图放入编辑模式");
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取结果图失败");
      }
    },
    [applyReferenceImagesToComposer, selectedConversation],
  );

  const handleSplitResultAsPsd = useCallback(async (image: StoredImage, index: number) => {
    const src = getStoredImageSrc(image);
    if (!src) return;
    try {
      const referenceImage = await resultImageToReference(src, index);
      window.sessionStorage.setItem(
        PSD_REFERENCE_TRANSFER_KEY,
        JSON.stringify({
          images: [referenceImage],
        }),
      );
      window.location.href = "/editable-files";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取结果图失败");
    }
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const turns = getImageThreadTurns(conversationsRef.current, id);
      if (turns.some((turn) => generatingIds.has(turn.id) || conversationHasRunnableImage(turn))) {
        toast.info("请等待本对话的生成任务完成后再删除");
        return;
      }
      for (const turn of turns) await deleteImageConversation(turn.id);
      conversationsRef.current = conversationsRef.current.filter((item) => getImageThreadId(item) !== id);
      setConversations((prev) => prev.filter((item) => getImageThreadId(item) !== id));
      if (selectedConversationId === id) handleNewConversation();
    },
    [selectedConversationId, generatingIds, handleNewConversation],
  );

  const handleResumeImageJob = useCallback(
    async (conversationId: string, imageId: string, jobId: string) => {
      try {
        await updateConversation(conversationId, (current) => ({
          ...(current ?? fallbackConversation(conversationId)),
          status: "generating",
          error: undefined,
          images: (current?.images ?? []).map((image) =>
            image.id === imageId
              ? {
                  ...image,
                  status: "loading" as const,
                  error: undefined,
                  canResume: false,
                  progress: "polling_image_result",
                  progressText: "继续等待图片结果",
                }
              : image,
          ),
        }));
        addGeneratingId(conversationId);
        await resumeImageJobPoll(jobId, 90);
        await waitForConversationImageJob(conversationId, imageId, jobId);
        await loadQuota();
        toast.success("继续等待已拿到图片");
      } catch (error) {
        const job = (error as Error & { job?: ImageJobStatus }).job;
        const message = error instanceof Error ? error.message : "继续等待失败";
        await updateConversation(conversationId, (current) => ({
          ...(current ?? fallbackConversation(conversationId, "error")),
          status: "error",
          error: message,
          images: (current?.images ?? []).map((image) =>
            image.id === imageId
              ? {
                  ...image,
                  status: "error" as const,
                  error: message,
                  canResume: job?.can_resume === true,
                  progress: job?.progress,
                  progressText: job?.progress_text,
                }
              : image,
          ),
        }));
        toast.error(message);
      } finally {
        removeGeneratingId(conversationId);
      }
    },
    [addGeneratingId, loadQuota, removeGeneratingId, updateConversation, waitForConversationImageJob],
  );

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) return;
      const revision = referenceRevisionRef.current;
      try {
        const storedImages = await Promise.all(
          imageFiles.map(async (file) => ({ name: file.name, type: file.type || "image/png", dataUrl: await readFileAsDataUrl(file) })),
        );
        if (!mountedRef.current || revision !== referenceRevisionRef.current) return;
        // Commit both lists together; failed/stale reads must not leave ghost files.
        setReferenceImageFiles((prev) => [...prev, ...imageFiles]);
        setReferenceImages((prev) => [...prev, ...storedImages]);
      } catch {
        if (mountedRef.current) toast.error("读取参考图失败，请重新选择图片");
      }
    },
    [],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    referenceRevisionRef.current += 1;
    setReferenceImageFiles((prev) => prev.filter((_, i) => i !== index));
    setReferenceImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleOpenMaskEditor = useCallback(
    (index: number) => {
      const image = referenceImages[index];
      if (image) {
        setMaskEditorImage(image.dataUrl);
        setMaskEditorIndex(index);
      }
    },
    [referenceImages],
  );

  const handleMaskConfirm = useCallback(
    (imageDataUrl: string, maskDataUrl: string) => {
      const dataUrlToFile = (dataUrl: string, filename: string): File => {
        const [header, data] = dataUrl.split(",");
        const mime = header.match(/:(.*?);/)?.[1] || "image/png";
        const binary = atob(data);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
        return new File([array], filename, { type: mime });
      };

      const imgFile = dataUrlToFile(imageDataUrl, "masked_image.png");
      const maskFile = dataUrlToFile(maskDataUrl, "mask.png");

      setReferenceImageFiles((prev) => {
        const next = [...prev];
        if (maskEditorIndex >= 0 && maskEditorIndex < next.length) {
          next[maskEditorIndex] = imgFile;
          next.splice(maskEditorIndex + 1, 0, maskFile);
        } else {
          next.push(imgFile, maskFile);
        }
        return next;
      });

      setReferenceImages((prev) => {
        const next = [...prev];
        const imgStored: StoredReferenceImage = { name: "masked_image.png", type: "image/png", dataUrl: imageDataUrl };
        if (maskEditorIndex >= 0 && maskEditorIndex < next.length) {
          next[maskEditorIndex] = imgStored;
          next.splice(maskEditorIndex + 1, 0, { name: "mask.png", type: "image/png", dataUrl: maskDataUrl });
        } else {
          next.push(imgStored, { name: "mask.png", type: "image/png", dataUrl: maskDataUrl });
        }
        return next;
      });

      setMaskEditorImage(null);
      setMaskEditorIndex(-1);
      toast.success("遮罩已应用");
    },
    [maskEditorIndex],
  );

  const handleMaskCancel = useCallback(() => {
    setMaskEditorImage(null);
    setMaskEditorIndex(-1);
  }, []);

  const handleImageModeChange = useCallback((mode: ImageConversationMode) => {
    setImageMode(mode);
  }, []);

  const handleGenerateImage = useCallback(async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }
    if (imageMode === "edit" && referenceImageFiles.length === 0) {
      toast.error("请上传参考图");
      return;
    }

    const conversationId = createId();
    const threadId = continuingThreadId || conversationId;
    const now = new Date().toISOString();
    const draftReferenceImages: StoredReferenceImage[] = [...referenceImages];
    const title = buildConversationTitle(prompt);
    const requestModel = imageModel;
    const genParams: Partial<ImageGenParams> = {
      quality: imageQuality,
      size: imageSize,
      output_format: imageOutputFormat,
      output_compression: imageOutputCompression,
      moderation: imageModeration,
    };

    const draftConversation: ImageConversation = {
      id: conversationId,
      threadId,
      title,
      prompt,
      model: requestModel,
      mode: imageMode,
      referenceImages: draftReferenceImages,
      generationSettings: {
        quality: imageQuality,
        size: imageSize,
        outputFormat: imageOutputFormat,
        outputCompression: imageOutputCompression,
        moderation: imageModeration,
      },
      count: parsedCount,
      images: Array.from({ length: parsedCount }, (_, index) => ({ id: `${conversationId}-${index}`, status: "loading" })),
      createdAt: now,
      status: "generating",
    };

    addGeneratingId(conversationId);
    setSelectedConversationId(threadId);
    setContinuingThreadId(threadId);
    resetComposer();

    try {
      await persistConversation(draftConversation);

      const tasks = Array.from({ length: parsedCount }, async (_, index) => {
        let submittedJobId = "";
        const imageId = `${conversationId}-${index}`;
        try {
          const job =
            imageMode === "edit" && referenceImageFiles.length > 0
              ? await createImageEditJob(referenceImageFiles, prompt, requestModel, {
                  client_conversation_id: conversationId,
                  client_image_id: imageId,
                })
              : await createImageGenerationJob(prompt, requestModel, {
                  ...genParams,
                  client_conversation_id: conversationId,
                  client_image_id: imageId,
                });
          submittedJobId = job.job_id;
          await updateConversation(conversationId, (current) => ({
            ...(current ?? draftConversation),
            images: (current?.images ?? draftConversation.images).map((image) =>
              image.id === imageId
                ? { ...image, jobId: job.job_id, progress: "queued", progressText: "排队中" }
                : image,
            ),
          }));
          return await waitForConversationImageJob(conversationId, imageId, job.job_id, draftConversation);
        } catch (error) {
          const jobStatus = (error as Error & { job?: ImageJobStatus }).job;
          const message = error instanceof Error ? error.message : `第 ${index + 1} 张生成失败`;
          const canKeepPolling = Boolean(submittedJobId) && jobStatus?.status !== "error";
          const failedImage: StoredImage = {
            id: imageId,
            status: canKeepPolling ? "loading" : "error",
            error: canKeepPolling ? undefined : message,
            jobId: jobStatus?.job_id || submittedJobId || undefined,
            progress: jobStatus?.progress,
            progressText: jobStatus?.progress_text,
            canResume: jobStatus?.can_resume === true,
          };
          await updateConversation(conversationId, (current) => ({
            ...(current ?? draftConversation),
            images: (current?.images ?? draftConversation.images).map((image) => (image.id === failedImage.id ? failedImage : image)),
          }));
          throw error;
        }
      });

      const settled = await Promise.allSettled(tasks);
      const successCount = settled.filter((item): item is PromiseFulfilledResult<StoredImage> => item.status === "fulfilled").length;
      const failedCount = settled.length - successCount;
      const latestConversation = conversationsRef.current.find((item) => item.id === conversationId);
      const hasPendingImages = (latestConversation?.images ?? []).some((image) => image.status === "loading" && image.jobId);

      if (successCount === 0 && !hasPendingImages) {
        const firstError = settled.find((item) => item.status === "rejected");
        throw new Error(firstError?.status === "rejected" ? String(firstError.reason) : "生成图片失败");
      }

      await updateConversation(conversationId, (current) => {
        const stillPending = (current?.images ?? []).some((image) => image.status === "loading" && image.jobId);
        return {
          ...(current ?? draftConversation),
          status: stillPending ? "generating" : failedCount > 0 ? "error" : "success",
          error: failedCount > 0 && !stillPending ? `其中 ${failedCount} 张生成失败` : undefined,
        };
      });

      await loadQuota();
      if (hasPendingImages) toast.info("任务已在后台继续生成，稍后打开会自动刷新结果");
      else if (failedCount > 0) toast.error(`已完成 ${successCount} 张，另有 ${failedCount} 张未生成成功`);
      else toast.success(imageMode === "edit" ? `已完成 ${successCount} 张图片编辑` : `已生成 ${successCount} 张图片`);
    } catch (error) {
      const message = error instanceof Error ? error.message : imageMode === "edit" ? "编辑图片失败" : "生成图片失败";
      const latestConversation = conversationsRef.current.find((item) => item.id === conversationId);
      const hasPendingImages = (latestConversation?.images ?? []).some((image) => image.status === "loading" && image.jobId);
      await updateConversation(conversationId, (current) => ({
        ...(current ?? draftConversation),
        status: hasPendingImages ? "generating" : "error",
        error: hasPendingImages ? undefined : message,
        images: (current?.images ?? draftConversation.images).map((image) =>
          image.status === "loading" && !image.jobId ? { ...image, status: "error" as const, error: message } : image,
        ),
      }));
      if (hasPendingImages) toast.info("任务已在后台继续生成，稍后打开会自动刷新结果");
      else toast.error(message);
    } finally {
      removeGeneratingId(conversationId);
    }
  }, [
    imagePrompt,
    continuingThreadId,
    imageMode,
    referenceImageFiles,
    referenceImages,
    imageModel,
    imageQuality,
    imageSize,
    imageOutputFormat,
    imageOutputCompression,
    imageModeration,
    parsedCount,
    addGeneratingId,
    resetComposer,
    persistConversation,
    updateConversation,
    loadQuota,
    removeGeneratingId,
  ]);

  const handleOptimizePrompt = useCallback(async () => {
    if (optimizingRef.current) return;
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    const revision = promptRevisionRef.current;
    optimizingRef.current = true;
    setIsOptimizingPrompt(true);
    try {
      const result = await optimizeImagePrompt(prompt);
      const optimizedPrompt = result.optimized_prompt.trim();
      if (!optimizedPrompt) {
        throw new Error("优化失败");
      }
      if (!mountedRef.current) return;
      if (revision !== promptRevisionRef.current) {
        toast.info("输入已变更，已保留你的新内容，请按需重新优化");
        return;
      }
      setImagePrompt(optimizedPrompt);
      if (result.truncated) toast.info("提示词已优化，输出已按长度上限截取");
      else toast.success("提示词已优化");
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "优化提示词失败");
    } finally {
      optimizingRef.current = false;
      if (mountedRef.current) setIsOptimizingPrompt(false);
    }
  }, [imagePrompt]);

  const handleQuickPromptSelect = useCallback((content: string) => {
    const addition = String(content || "").trim();
    if (!addition) return;
    setImagePrompt((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed}\n${addition}` : addition;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const renderTurn = (turn: ImageConversation | null) => (
    <ImageResults
      selectedConversation={turn}
      isSelectedGenerating={turn !== null && generatingIds.has(turn.id)}
      openLightbox={openLightbox}
      onReuseConversation={handleReuseConversation}
      onUseResultAsReference={(image, index) => handleUseResultAsReference(image, index, turn)}
      onSplitAsPsd={handleSplitResultAsPsd}
      onResumeImageJob={handleResumeImageJob}
      formatConversationTime={formatConversationTime}
    />
  );

  const canvasTurn = selectedTurns.find(turn => turn.id === canvasTurnId) ?? selectedTurns[selectedTurns.length - 1] ?? null;
  const visibleTurns = variant === "b" ? (canvasTurn ? [canvasTurn] : []) : selectedTurns;

  useEffect(() => setCanvasTurnId(null), [selectedConversationId, selectedTurns.length]);

  const resultsPanel = (
    <div className="space-y-8">
      {visibleTurns.length ? visibleTurns.map((turn) => (
        <div key={turn.id} className="space-y-4">
          <div className="text-center text-xs text-stone-500 dark:text-slate-400">第 {selectedTurns.indexOf(turn) + 1} 轮</div>
          {renderTurn(turn)}
        </div>
      )) : renderTurn(null)}
      <div ref={resultsEndRef} />
    </div>
  );

  const composerPanel = (
    <ImageComposer
      mode={imageMode}
      model={imageModel}
      prompt={imagePrompt}
      imageCount={imageCount}
      size={imageSize}
      outputFormat={imageOutputFormat}
      availableQuota={availableQuota}
      hasAnyGenerating={hasAnyGenerating}
      generatingCount={generatingIds.size}
      referenceImages={referenceImages}
      quickPrompts={quickPrompts}
      textareaRef={textareaRef}
      fileInputRef={fileInputRef}
      onModeChange={handleImageModeChange}
      onModelChange={setImageModel}
      onPromptChange={setImagePrompt}
      onImageCountChange={setImageCount}
      onSizeChange={setImageSize}
      onOutputFormatChange={setImageOutputFormat}
      onQuickPromptSelect={handleQuickPromptSelect}
      onOptimizePrompt={handleOptimizePrompt}
      onSubmit={handleGenerateImage}
      onPickReferenceImage={() => fileInputRef.current?.click()}
      onReferenceImageChange={handleReferenceImageChange}
      onRemoveReferenceImage={handleRemoveReferenceImage}
      onOpenMaskEditor={handleOpenMaskEditor}
      isOptimizingPrompt={isOptimizingPrompt}
    />
  );

  return (
    <>
      <section className={cn("studio-workspace", historyCollapsed && "history-collapsed")} data-layout={variant} aria-label={variant === "a" ? "雾白靛蓝对话工作台" : "石墨青绿画布工作台"}>
        <div ref={historyPanelRef} className="studio-history-panel">
          <ImageSidebar
            conversations={threadSummaries} isLoadingHistory={isLoadingHistory}
            generatingIds={generatingThreadIds} selectedConversationId={selectedConversationId}
            collapsed={historyCollapsed} onToggleCollapsed={() => setHistoryCollapsed(value => !value)}
            onSelectConversation={handleSelectConversation} onDeleteConversation={handleDeleteConversation}
            formatConversationTime={formatConversationTime} onNewConversation={handleNewConversation}
          />
        </div>
        <div className="studio-results-panel">
          <header className="studio-results-heading">
            <div className="min-w-0"><h1 className="truncate text-base font-medium">{selectedConversation?.title || "开始创作"}</h1><span className="text-xs text-muted-foreground">{selectedTurns.length ? selectedTurns.length + " 轮对话 · 随时继续修改" : "描述画面，或上传参考图"}</span></div>
            <div className="flex shrink-0 items-center gap-2"><span className="studio-quota">积分 {availableQuota}</span><button type="button" className="studio-icon-button" aria-label="查看对话历史" onClick={() => { if (isWideLayout && variant === "a") setHistoryCollapsed(false); else setMobileHistoryOpen(true); }}><History size={17} /></button></div>
          </header>
          <div ref={resultsScrollRef} data-testid="image-results-scroll" className="studio-results-scroll">
            <div className="studio-results-inner">{resultsPanel}</div>
          </div>
          {variant === "b" && selectedTurns.length > 0 && <nav className="studio-rounds" aria-label="生成轮次">{selectedTurns.map((turn, index) => <button key={turn.id} type="button" aria-pressed={turn.id === canvasTurn?.id} onClick={() => setCanvasTurnId(turn.id)}>第 {index + 1} 轮{generatingIds.has(turn.id) ? " · 生成中" : ""}</button>)}</nav>}
        </div>
        <div className="studio-composer-panel">
          <div className="studio-composer-heading"><span>{continuingThreadId ? "继续当前对话 · 已有 " + selectedTurns.length + " 轮" : "新对话"}</span><button type="button" onClick={handleNewConversation} className="studio-text-button"><Plus size={15} />新建对话</button></div>
          {composerPanel}
        </div>
      </section>

      {(!isWideLayout || variant === "b") && <SideDrawer open={mobileHistoryOpen} onOpenChange={setMobileHistoryOpen} title="图片历史记录">
        <ImageSidebar
          conversations={threadSummaries} isLoadingHistory={isLoadingHistory}
          generatingIds={generatingThreadIds} selectedConversationId={selectedConversationId}
          collapsed={false} onToggleCollapsed={() => setMobileHistoryOpen(false)}
          onSelectConversation={(id) => { handleSelectConversation(id); setMobileHistoryOpen(false); }}
          onDeleteConversation={handleDeleteConversation} formatConversationTime={formatConversationTime}
          onNewConversation={() => { handleNewConversation(); setMobileHistoryOpen(false); }}
        />
      </SideDrawer>}

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
      {maskEditorImage ? <MaskEditor imageUrl={maskEditorImage} onConfirm={handleMaskConfirm} onCancel={handleMaskCancel} /> : null}
    </>
  );
}
