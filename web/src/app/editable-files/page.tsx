"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  FileArchive,
  FileImage,
  FileText,
  History,
  ImagePlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createEditableFileTask,
  fetchEditableFileTasks,
  fetchPublicAppConfig,
  fetchUserKeyInfo,
  type EditableFileKind,
  type EditableFileTask,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  listDeletedEditableFileIds,
  listEditableFileDrafts,
  saveDeletedEditableFileIds,
  saveEditableFileDrafts,
  type EditableFileDraft,
} from "@/store/editable-file-history";

const MAX_HISTORY = 30;
const PSD_REFERENCE_TRANSFER_KEY = "editable-files:incoming-psd-reference";
const DEFAULT_PROMPTS: Record<EditableFileKind, string> = {
  ppt: "做一份 5-6 页产品介绍 PPT，版式清晰、配色统一、文字可编辑。",
  psd: "按参考图生成可编辑 PSD，拆分背景、文字、图形和主要元素，保留相对位置。",
};

type ReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
};

function createClientTaskId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function taskIdOf(task: EditableFileTask | null | undefined) {
  return task?.taskId || task?.id || "";
}

function isRunning(task: EditableFileTask | null | undefined) {
  return task?.status === "queued" || task?.status === "running";
}

function statusText(status: string) {
  return (
    {
      queued: "排队中",
      running: "生成中",
      success: "已完成",
      error: "失败",
    }[status] || status
  );
}

function statusVariant(status: string): "success" | "warning" | "danger" | "outline" {
  if (status === "success") return "success";
  if (status === "error") return "danger";
  if (status === "queued" || status === "running") return "warning";
  return "outline";
}

function formatElapsed(seconds: number) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${String(value % 60).padStart(2, "0")}s`;
}

function elapsedOf(task: EditableFileTask | null | undefined, now: number) {
  if (!task) return 0;
  const base = Math.max(0, Number(task.elapsed_seconds || 0));
  if (!isRunning(task) || !task.polled_at) return base;
  return Math.max(0, base + Math.floor((now - task.polled_at) / 1000));
}

function titleOfPrompt(prompt: string, fallback: string) {
  const title = prompt.trim().replace(/\s+/g, " ").slice(0, 24);
  return title || fallback;
}

function fileNameOf(url: string) {
  try {
    return decodeURIComponent(new URL(url, window.location.origin).pathname.split("/").pop() || "");
  } catch {
    return decodeURIComponent(url.split("/").pop() || "");
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function mergeTasks(current: EditableFileTask[], updates: EditableFileTask[]) {
  const next = [...current];
  for (const update of updates) {
    const id = taskIdOf(update);
    if (!id) continue;
    const index = next.findIndex((item) => taskIdOf(item) === id);
    const merged = { ...(index >= 0 ? next[index] : {}), ...update, polled_at: Date.now() };
    if (index >= 0) next[index] = merged;
    else next.unshift(merged);
  }
  return next.slice(0, MAX_HISTORY);
}

function removeTasks(current: EditableFileTask[], ids: string[]) {
  const missing = new Set(ids);
  return missing.size ? current.filter((task) => !missing.has(taskIdOf(task))) : current;
}

export default function EditableFilesPage() {
  const [kind, setKind] = useState<EditableFileKind>("psd");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPTS.psd);
  const [images, setImages] = useState<ReferenceImage[]>([]);
  const [tasks, setTasks] = useState<EditableFileTask[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableFileDraft>>({});
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState("");
  const [availableQuota, setAvailableQuota] = useState("加载中");
  const [psdTaskPrice, setPsdTaskPrice] = useState(1);
  const [renamingId, setRenamingId] = useState("");
  const [renamingTitle, setRenamingTitle] = useState("");
  const [now, setNow] = useState(Date.now());
  const isPptDisabled = kind === "ppt";

  const visibleTasks = useMemo(
    () => tasks.filter((task) => task.kind === kind && !deletedIds.has(taskIdOf(task))).slice(0, MAX_HISTORY),
    [deletedIds, kind, tasks],
  );
  const selectedTask = visibleTasks.find((task) => taskIdOf(task) === selectedId) || visibleTasks[0] || null;
  const runningIds = useMemo(() => visibleTasks.filter(isRunning).map(taskIdOf).filter(Boolean), [visibleTasks]);

  const loadQuota = useCallback(async () => {
    try {
      const data = await fetchUserKeyInfo();
      setAvailableQuota(data.remaining === -1 ? "无限" : String(data.remaining));
    } catch {
      setAvailableQuota("未知");
    }
  }, []);

  const persistDrafts = useCallback(
    (updater: (current: Record<string, EditableFileDraft>) => Record<string, EditableFileDraft>) => {
      setDrafts((current) => {
        const next = updater(current);
        void saveEditableFileDrafts(kind, next);
        return next;
      });
    },
    [kind],
  );

  const fetchTasks = useCallback(
    async (ids: string[] = []) => {
      const taskIds = Array.from(new Set(ids.filter(Boolean))).slice(0, MAX_HISTORY);
      setPolling(true);
      try {
        const [result, hidden] = await Promise.all([fetchEditableFileTasks(taskIds), listDeletedEditableFileIds(kind)]);
        const missingIds = result.missing_ids || [];
        setDeletedIds(hidden);
        setTasks((current) => {
          const incoming = (result.items || []).filter((task) => task.kind === kind && !hidden.has(taskIdOf(task)));
          if (taskIds.length) return mergeTasks(removeTasks(current, missingIds), incoming);
          return incoming.slice(0, MAX_HISTORY);
        });
        setSelectedId((current) => (current && missingIds.includes(current) ? "" : current));
      } catch (err) {
        const message = err instanceof Error ? err.message : "读取任务失败";
        setError(message);
        toast.error(message);
      } finally {
        setPolling(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setError("");
      setPrompt(DEFAULT_PROMPTS[kind]);
      setImages([]);
      setTasks([]);
      setSelectedId("");
      try {
        const [loadedDrafts, loadedDeleted] = await Promise.all([listEditableFileDrafts(kind), listDeletedEditableFileIds(kind)]);
        if (!cancelled) {
          setDrafts(loadedDrafts);
          setDeletedIds(loadedDeleted);
        }
      } catch {
        if (!cancelled) {
          setDrafts({});
          setDeletedIds(new Set());
        }
      }
      if (!cancelled) void fetchTasks();
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchTasks, kind]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(PSD_REFERENCE_TRANSFER_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(PSD_REFERENCE_TRANSFER_KEY);
    try {
      const payload = JSON.parse(raw) as { images?: ReferenceImage[] };
      const incomingImages = Array.isArray(payload.images)
        ? payload.images.filter((image) => image && typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:image/"))
        : [];
      if (!incomingImages.length) return;
      setKind("psd");
      setSelectedId("");
      setPrompt(DEFAULT_PROMPTS.psd);
      setImages(incomingImages);
      setError("");
      setRenamingId("");
      toast.success("已添加到 PSD 拆分参考图");
    } catch {
      toast.error("读取 PSD 参考图失败");
    }
  }, []);

  useEffect(() => {
    void loadQuota();
  }, [loadQuota]);

  useEffect(() => {
    let cancelled = false;
    const loadPublicConfig = async () => {
      try {
        const data = await fetchPublicAppConfig();
        if (!cancelled) setPsdTaskPrice(Math.max(0, Number(data.psd_task_price ?? 1)));
      } catch {
        if (!cancelled) setPsdTaskPrice(1);
      }
    };

    void loadPublicConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runningIds.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningIds.length]);

  useEffect(() => {
    if (!runningIds.length) return;
    const timer = window.setInterval(() => void fetchTasks(runningIds), 60000);
    return () => window.clearInterval(timer);
  }, [fetchTasks, runningIds]);

  useEffect(() => {
    if (selectedId && visibleTasks.some((task) => taskIdOf(task) === selectedId)) return;
    setSelectedId(visibleTasks[0] ? taskIdOf(visibleTasks[0]) : "");
  }, [selectedId, visibleTasks]);

  const appendFiles = async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    try {
      const nextImages = await Promise.all(
        imageFiles.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );
      setImages((current) => [...current, ...nextImages]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "读取图片失败");
    }
  };

  const selectTask = (task: EditableFileTask) => {
    const id = taskIdOf(task);
    setSelectedId(id);
    setRenamingId("");
    setPrompt(drafts[id]?.prompt || task.prompt_preview || DEFAULT_PROMPTS[kind]);
    setImages((drafts[id]?.images || []).map((dataUrl, index) => ({ name: `reference_${index + 1}.png`, type: "image/png", dataUrl })));
  };

  const createDraft = () => {
    setSelectedId("");
    setPrompt(DEFAULT_PROMPTS[kind]);
    setImages([]);
    setError("");
    setRenamingId("");
  };

  const renameTask = (id: string, title: string) => {
    const trimmed = title.trim();
    if (!id || !trimmed) return;
    persistDrafts((current) => ({ ...current, [id]: { ...(current[id] || {}), title: trimmed } }));
  };

  const hideTask = (id: string) => {
    if (!id) return;
    const nextDeleted = new Set(deletedIds);
    nextDeleted.add(id);
    setDeletedIds(nextDeleted);
    void saveDeletedEditableFileIds(kind, nextDeleted);
    setTasks((current) => current.filter((task) => taskIdOf(task) !== id));
    persistDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (selectedId === id) setSelectedId("");
  };

  const clearHistory = () => {
    const ids = visibleTasks.map(taskIdOf).filter(Boolean);
    if (!ids.length) return;
    const nextDeleted = new Set([...deletedIds, ...ids]);
    setDeletedIds(nextDeleted);
    void saveDeletedEditableFileIds(kind, nextDeleted);
    setTasks((current) => current.filter((task) => !ids.includes(taskIdOf(task))));
    persistDrafts((current) => {
      const next = { ...current };
      ids.forEach((id) => delete next[id]);
      return next;
    });
    setSelectedId("");
  };

  const submit = async () => {
    if (isPptDisabled) {
      toast.error("PPT 模块开发中");
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      toast.error("请输入需求");
      return;
    }
    if (kind === "psd" && !images.length) {
      toast.error("PSD 需要至少一张参考图");
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      const base64Images = images.map((image) => image.dataUrl);
      const expectedCharge = kind === "psd" ? psdTaskPrice * base64Images.length : 0;
      const task = await createEditableFileTask(kind, {
        client_task_id: createClientTaskId(),
        prompt: trimmedPrompt,
        base64_images: base64Images,
      });
      const id = taskIdOf(task);
      const nextTask = { ...task, prompt_preview: trimmedPrompt, polled_at: Date.now() };
      persistDrafts((current) => ({
        ...current,
        [id]: { prompt: trimmedPrompt, images: base64Images, title: titleOfPrompt(trimmedPrompt, `${kind.toUpperCase()} 任务`) },
      }));
      setTasks((current) => mergeTasks(current.filter((item) => taskIdOf(item) !== id), [nextTask]));
      setSelectedId(id);
      setNow(Date.now());
      await loadQuota();
      toast.success(expectedCharge > 0 ? `任务已提交，预计消耗 ${expectedCharge} 积分` : "任务已提交");
    } catch (err) {
      const message = err instanceof Error ? err.message : "提交任务失败";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedTitle = selectedTask
    ? drafts[taskIdOf(selectedTask)]?.title ||
      titleOfPrompt(drafts[taskIdOf(selectedTask)]?.prompt || selectedTask.prompt_preview || "", `${selectedTask.kind.toUpperCase()} 任务`)
    : "暂无任务";

  return (
    <section className="grid min-h-[calc(100vh-8.5rem)] gap-3 xl:grid-cols-[300px_minmax(360px,430px)_minmax(0,1fr)]">
      <aside className="glass-panel section-shell flex min-h-[280px] flex-col overflow-hidden rounded-[20px] border border-white/60 sm:rounded-[28px]">
        <div className="flex items-center justify-between border-b border-white/55 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-stone-950">
            <History className="size-4" />
            历史记录
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" className="size-8 rounded-xl px-0" onClick={createDraft} title="新建">
              <Plus className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" className="size-8 rounded-xl px-0" onClick={() => void fetchTasks()} disabled={polling} title="刷新">
              {polling ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </Button>
            <Button size="sm" variant="ghost" className="size-8 rounded-xl px-0 text-stone-500 hover:text-rose-500" onClick={clearHistory} disabled={!visibleTasks.length} title="清空">
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 border-b border-white/55 p-2">
          <ModeButton active={kind === "psd"} onClick={() => setKind("psd")} icon={<FileImage className="size-4" />} label="PSD" />
          <ModeButton active={kind === "ppt"} onClick={() => setKind("ppt")} icon={<FileText className="size-4" />} label="PPT" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visibleTasks.length ? (
            visibleTasks.map((task) => {
              const id = taskIdOf(task);
              const title = drafts[id]?.title || titleOfPrompt(drafts[id]?.prompt || task.prompt_preview || "", `${task.kind.toUpperCase()} 任务`);
              const active = selectedTask && taskIdOf(selectedTask) === id;
              return (
                <div
                  key={id}
                  className={cn(
                    "group mb-2 rounded-[16px] border px-3 py-2.5 transition",
                    active ? "border-stone-950 bg-white/85 shadow-sm" : "border-transparent hover:border-white/70 hover:bg-white/60",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <button type="button" onClick={() => selectTask(task)} className="min-w-0 flex-1 text-left">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        {renamingId === id ? (
                          <Input
                            value={renamingTitle}
                            onChange={(event) => setRenamingTitle(event.target.value)}
                            onBlur={() => {
                              renameTask(id, renamingTitle);
                              setRenamingId("");
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                renameTask(id, renamingTitle);
                                setRenamingId("");
                              }
                              if (event.key === "Escape") setRenamingId("");
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="h-8 min-w-0 rounded-xl border-stone-200 bg-white text-sm font-semibold"
                            autoFocus
                          />
                        ) : (
                          <span className="truncate text-sm font-semibold text-stone-950">{title}</span>
                        )}
                        <Badge variant={statusVariant(task.status)} className="shrink-0 rounded-md px-2 py-0.5">
                          {statusText(task.status)}
                        </Badge>
                      </div>
                      <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-stone-500">
                        <Clock3 className="size-3.5 shrink-0" />
                        <span className="shrink-0 tabular-nums">{formatElapsed(elapsedOf(task, now))}</span>
                        <span className="truncate">{task.created_at || id}</span>
                      </div>
                      {drafts[id]?.prompt || task.prompt_preview ? (
                        <div className="mt-2 line-clamp-2 text-xs leading-5 text-stone-500">{drafts[id]?.prompt || task.prompt_preview}</div>
                      ) : null}
                    </button>
                    <div className="flex shrink-0 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="size-7 rounded-lg px-0"
                        onClick={() => {
                          setRenamingId(id);
                          setRenamingTitle(title);
                        }}
                        title="重命名"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="size-7 rounded-lg px-0 text-stone-400 hover:text-rose-500" onClick={() => hideTask(id)} title="删除">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex min-h-48 items-center justify-center text-sm text-stone-400">暂无记录</div>
          )}
        </div>
      </aside>

      <section className="glass-panel section-shell flex min-h-[480px] flex-col overflow-hidden rounded-[20px] border border-white/60 sm:rounded-[28px]">
        <div className="flex items-center justify-between gap-3 border-b border-white/55 px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight text-stone-950">{kind === "psd" ? "PSD 生成" : "PPT 生成"}</h1>
            <div className="mt-1 text-xs text-stone-500">
              {kind === "psd" ? `积分 ${availableQuota} · 每张参考图消耗 ${psdTaskPrice} 积分` : `积分 ${availableQuota} · 开发中`}
            </div>
          </div>
          <Button className="h-9 rounded-full bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => void submit()} disabled={isPptDisabled || submitting || runningIds.length > 0}>
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
            {isPptDisabled ? "开发中" : "生成"}
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {isPptDisabled ? (
            <div className="flex gap-2 rounded-[16px] border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>PPT 模块开发中，暂时不能输入或生成。</span>
            </div>
          ) : null}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-stone-600" htmlFor="editable-file-prompt">
              需求
            </label>
            <Textarea
              id="editable-file-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={isPptDisabled}
              className="min-h-48 rounded-[18px] border-white/70 bg-white/80 text-sm leading-6 shadow-none focus-visible:ring-stone-300"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-stone-600">参考图</label>
              <Badge variant={kind === "psd" && !images.length ? "warning" : "outline"} className="rounded-md">
                {images.length}
              </Badge>
            </div>
            {kind === "psd" ? (
              <div className="text-xs leading-5 text-stone-500">
                每张参考图消耗 {psdTaskPrice} 积分，当前预计消耗 {psdTaskPrice * images.length} 积分。
              </div>
            ) : null}
            <label
              className={cn(
                "flex h-24 items-center justify-center gap-2 rounded-[18px] border border-dashed border-stone-300 bg-white/55 text-sm font-medium text-stone-600 transition",
                isPptDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-stone-500 hover:bg-white/80",
              )}
            >
              <ImagePlus className="size-4" />
              上传图片
              <Input type="file" accept="image/*" multiple disabled={isPptDisabled} className="hidden" onChange={(event) => void appendFiles(event.target.files || [])} />
            </label>
            {images.length ? (
              <div className="grid grid-cols-4 gap-2">
                {images.map((image, index) => (
                  <div key={`${image.dataUrl.slice(0, 32)}-${index}`} className="group relative aspect-square overflow-hidden rounded-[14px] border border-white/70 bg-white/60">
                    <img src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded-full bg-white/90 text-stone-500 opacity-0 shadow-sm transition hover:text-rose-500 group-hover:opacity-100"
                      onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      disabled={isPptDisabled}
                      aria-label="移除图片"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="h-9 rounded-full border-white/70 bg-white/70 text-stone-700 shadow-none" onClick={() => setImages([])} disabled={isPptDisabled || !images.length}>
              <Trash2 className="size-4" />
              清空图片
            </Button>
            <Button variant="outline" className="h-9 rounded-full border-white/70 bg-white/70 text-stone-700 shadow-none" onClick={createDraft} disabled={isPptDisabled}>
              <Plus className="size-4" />
              新建草稿
            </Button>
          </div>

          {error ? (
            <div className="flex gap-2 rounded-[16px] border border-rose-200 bg-rose-50/80 px-3 py-2 text-sm text-rose-700">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="glass-panel section-shell flex min-h-[480px] flex-col overflow-hidden rounded-[20px] border border-white/60 sm:rounded-[28px]">
        <div className="flex items-center justify-between gap-3 border-b border-white/55 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-stone-950">{selectedTitle}</h2>
            <div className="mt-1 truncate text-xs text-stone-500">{selectedTask ? taskIdOf(selectedTask) : "等待任务"}</div>
          </div>
          {selectedTask ? (
            <Badge variant={statusVariant(selectedTask.status)} className="shrink-0 rounded-md px-2.5 py-1">
              {statusText(selectedTask.status)}
            </Badge>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {selectedTask ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatusTile
                  label="状态"
                  value={statusText(selectedTask.status)}
                  icon={
                    selectedTask.status === "success" ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : selectedTask.status === "error" ? (
                      <XCircle className="size-4 text-rose-500" />
                    ) : (
                      <LoaderCircle className="size-4 animate-spin text-amber-500" />
                    )
                  }
                />
                <StatusTile label="已执行" value={formatElapsed(elapsedOf(selectedTask, now))} />
                <StatusTile label="类型" value={selectedTask.kind.toUpperCase()} />
              </div>

              {selectedTask.result ? (
                <div className="space-y-3 rounded-[18px] border border-white/70 bg-white/70 p-3">
                  <div className="text-sm font-semibold text-stone-950">生成结果</div>
                  <ResultFile href={selectedTask.result.primary_url} label={kind === "ppt" ? "PPT 文件" : "PSD 文件"} icon={<FileText className="size-4" />} />
                  <ResultFile href={selectedTask.result.zip_url} label="素材包" icon={<FileArchive className="size-4" />} />
                </div>
              ) : (
                <div className="space-y-3 rounded-[18px] border border-white/70 bg-white/60 p-5 text-sm text-stone-500">
                  <div>{isRunning(selectedTask) ? "任务执行中" : "暂无结果文件"}</div>
                </div>
              )}

              {selectedTask.error ? (
                <div className="rounded-[16px] border border-rose-200 bg-rose-50/80 px-3 py-2 text-sm text-rose-700">{selectedTask.error}</div>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-80 items-center justify-center text-sm text-stone-400">暂无任务</div>
          )}
        </div>
      </section>
    </section>
  );
}

function ModeButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-[14px] border text-sm font-medium transition",
        active ? "border-stone-950 bg-stone-950 text-white" : "border-white/70 bg-white/60 text-stone-600 hover:bg-white/85 hover:text-stone-950",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function StatusTile({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="rounded-[18px] border border-white/70 bg-white/65 p-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="mt-2 flex min-w-0 items-center gap-2 text-sm font-semibold text-stone-950">
        {icon}
        <span className="truncate tabular-nums">{value}</span>
      </div>
    </div>
  );
}

function ResultFile({ href, icon, label }: { href?: string; icon: ReactNode; label: string }) {
  if (!href) return null;
  return (
    <div className="flex items-center gap-3 rounded-[16px] border border-white/70 bg-white/75 px-3 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-stone-950 text-white">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-stone-950">{label}</div>
        <div className="truncate text-xs text-stone-500">{fileNameOf(href)}</div>
      </div>
      <Button asChild className="h-9 rounded-full bg-stone-950 px-3 text-white hover:bg-stone-800">
        <a href={href} target="_blank" rel="noreferrer">
          <Download className="size-4" />
          下载
        </a>
      </Button>
    </div>
  );
}
