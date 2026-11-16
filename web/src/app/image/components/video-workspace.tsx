"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Film, ImagePlus, LoaderCircle, Music2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useDesign } from "@/components/design-provider";
import { PersonalPrompts } from "@/components/personal-prompts";
import { createVideoJob, fetchPublicAppConfig, fetchUserKeyInfo, fetchVideoJobs, uploadVideoAsset, type PublicAppConfig, type VideoGenerationParams, type VideoJob } from "@/lib/api";

type Attachment = { id: string; file: File; preview: string; assetId?: string };
const terminal = (job: VideoJob) => ["done", "failed", "expired"].includes(job.status);
const statusText: Record<string, string> = { preparing: "准备中", queued: "排队中", submitting: "正在提交", pending: "正在生成", done: "生成完成", failed: "生成失败", expired: "任务已过期", unknown: "等待管理员核对" };
const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const selectClass = "h-10 w-full rounded-lg border bg-background px-3 text-sm";

export function VideoWorkspace() {
  const { variant } = useDesign();
  const [config, setConfig] = useState<PublicAppConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<VideoGenerationParams["mode"]>("text");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("480p");
  const [ratio, setRatio] = useState("16:9");
  const [generateAudio, setGenerateAudio] = useState(true);
  const [voice, setVoice] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [audio, setAudio] = useState<Attachment | null>(null);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [quota, setQuota] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef<VideoGenerationParams | null>(null);
  const submitting = useRef(false);
  const previews = useRef(new Set<string>());
  const outputRef = useRef<HTMLDivElement>(null);
  const models = config?.video_models || [];
  const model = models.find(m => m.id === modelId);
  const referenceMode = mode === "reference";
  const maxDuration = model ? (referenceMode ? model.reference_max_duration : model.max_duration) : 15;
  const maxImages = mode === "image" ? 1 : model?.max_reference_images || 0;
  const price = duration * (resolution === "720p" ? (config?.video_720p_credits_per_second ?? (config?.video_credits_per_second || 1) * 2) : (config?.video_credits_per_second || 1));
  const active = jobs.find(j => !terminal(j));
  const selected = jobs.find(j => j.request_id === selectedId) || jobs[0];

  const loadConfig = useCallback(async () => {
    try {
      const next = await fetchPublicAppConfig();
      setConfig(next); setConfigError("");
      setModelId(current => next.video_models?.some(m => m.id === current) ? current : next.default_video_model || next.video_models?.[0]?.id || "");
    } catch (error) { setConfigError(error instanceof Error ? error.message : "模型加载失败"); }
  }, []);
  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await fetchVideoJobs();
        if (stopped) return;
        setJobs(next.items); setHistoryError(""); setHistoryLoaded(true);
        const info = await fetchUserKeyInfo();
        if (!stopped) setQuota(Number(info.remaining ?? 0));
      } catch (error) {
        if (!stopped) setHistoryError(error instanceof Error ? error.message : "视频记录暂时无法加载");
      } finally { if (!stopped) timer = setTimeout(poll, 5000); }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [retry]);
  useEffect(() => () => { previews.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => {
    if (!model) return;
    setDuration(value => Math.max(model.min_duration, Math.min(value, maxDuration)));
    setResolution(value => model.resolutions.includes(value as "480p" | "720p") ? value : model.resolutions[0]);
  }, [model, maxDuration]);

  const changed = () => { request.current = null; setSubmitError(""); };
  const release = (item: Attachment) => { URL.revokeObjectURL(item.preview); previews.current.delete(item.preview); };
  const clearReferences = () => { images.forEach(release); if (audio) release(audio); setImages([]); setAudio(null); setVoice(""); };
  const changeMode = (next: VideoGenerationParams["mode"]) => { changed(); clearReferences(); setMode(next); };
  const attach = async (files: File[], kind: "image" | "audio") => {
    changed();
    const selectedFiles = files.slice(0, kind === "image" ? Math.max(0, maxImages - images.length) : 1);
    if (selectedFiles.length < files.length) toast.info(`最多添加 ${kind === "image" ? maxImages + " 张图片" : "一个音频"}`);
    const additions: Attachment[] = [];
    for (const file of selectedFiles) {
      const valid = kind === "image" ? ["image/png", "image/jpeg", "image/webp"].includes(file.type) : /\.(mp3|wav)$/i.test(file.name);
      if (!valid || file.size > (kind === "image" ? 5 : 20) * 1024 * 1024) { toast.error(kind === "image" ? "图片仅支持 PNG/JPEG/WebP，每张最多 5 MB" : "音频仅支持 MP3/WAV，最多 20 MB、2–15 秒"); continue; }
      const preview = URL.createObjectURL(file); previews.current.add(preview);
      additions.push({ id: crypto.randomUUID(), file, preview });
    }
    if (kind === "image") setImages(current => [...current, ...additions].slice(0, maxImages));
    else if (additions[0]) { if (audio) release(audio); setAudio(additions[0]); }
  };

  const submit = async () => {
    if (submitting.current || !model || !prompt.trim() || active) return;
    if (mode === "image" && images.length !== 1) return toast.error("请添加一张首帧图片");
    if (referenceMode && !images.length && !audio && !voice.trim()) return toast.error("请添加参考图或音频");
    if (audio && !images.length) return toast.error("参考音频需搭配至少一张参考图");
    const voiceIds = voice.split(",").map(value => value.trim()).filter(Boolean);
    if (voiceIds.length > 3 || voiceIds.some(value => !/^[a-zA-Z0-9_-]{1,64}$/.test(value))) return toast.error("最多填写三个有效音色 ID，以英文逗号分隔");
    submitting.current = true; setBusy(true); setSubmitError("");
    try {
      if (!request.current) {
        const imageIds: { asset_id: string }[] = [];
        for (const [index, item] of images.entries()) {
          setStage(`上传参考图 ${index + 1}/${images.length}`);
          const id = item.assetId || (await uploadVideoAsset(item.file, "image")).asset_id;
          item.assetId = id; imageIds.push({ asset_id: id });
        }
        const audios: { asset_id?: string; voice_id?: string }[] = [];
        if (audio) {
          setStage("上传参考音频");
          const id = audio.assetId || (await uploadVideoAsset(audio.file, "audio")).asset_id;
          audio.assetId = id; audios.push({ asset_id: id });
        }
        if (voiceIds.length) audios.push(...voiceIds.map(voice_id => ({ voice_id })));
        request.current = { model: model.id, prompt: prompt.trim(), duration, resolution, aspect_ratio: ratio, mode, generate_audio: generateAudio, reference_images: imageIds, reference_audios: audios, client_request_id: crypto.randomUUID() };
      }
      setStage("提交后台任务");
      const created = await createVideoJob(request.current);
      setJobs(current => [created, ...current.filter(j => j.request_id !== created.request_id)]);
      setSelectedId(created.request_id); request.current = null;
      if (window.innerWidth <= 900) requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      toast.success("视频任务已提交，可离开页面，稍后回来查看");
      setRetry(value => value + 1);
    } catch (error) { setSubmitError(error instanceof Error ? error.message : "提交失败，请重试"); }
    finally { submitting.current = false; setBusy(false); setStage(""); }
  };

  return <section aria-label="视频创作工作台" data-layout={variant} className="video-workspace">
    <div ref={outputRef} className="video-output">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div><h1 className="font-medium">视频创作</h1><p className="text-xs text-muted-foreground">描述镜头与动作，或用参考素材引导演绎</p></div><span className="text-sm">积分 {quota ?? "—"}</span></header>
      {historyError && <div role="alert" className="p-4 text-sm text-amber-700 dark:text-amber-300">{historyError}<Button variant="ghost" onClick={() => setRetry(v => v + 1)}><RefreshCw size={14} />重试查询</Button></div>}
      <div className="video-preview p-4 sm:p-6">
        {!selected ? <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><Film size={40} strokeWidth={1} /><h2 className="text-lg text-foreground">把想象变成一段视频</h2><p className="max-w-sm text-sm">先选择模型，再描述场景、人物动作与镜头运动。生成结果会保存在这里。</p></div> : <article className="space-y-4">
          <div className="flex flex-wrap justify-between gap-2 text-sm"><span role="status">{statusText[selected.status] || selected.status}</span><span className="text-muted-foreground">{selected.duration} 秒 · {selected.resolution} · {selected.credits} 积分</span></div>
          {selected.video ? <><video key={selected.video.url} controls playsInline preload="metadata" className="max-h-[55dvh] w-full rounded-xl bg-black" src={selected.video.url} /><a className="inline-flex min-h-10 items-center text-sm underline underline-offset-4" href={selected.video.url} target="_blank" rel="noopener noreferrer">打开 / 保存视频</a><p className="text-xs text-muted-foreground">视频地址由上游提供，可能过期，请及时保存。</p></> : <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20">{!terminal(selected) && selected.status !== "unknown" ? <LoaderCircle className="animate-spin text-primary" /> : <Film className="text-muted-foreground" />}<p className="text-sm">{selected.status === "unknown" ? "提交结果待核对，请联系管理员，不要重复生成" : terminal(selected) ? (selected.accounted ? "生成未完成，积分已退回" : "正在处理退款") : "任务在后台运行，刷新或关闭页面不会中断"}</p></div>}
          {selected.error && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{selected.error}</p>}
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-sm">{selected.prompt}</p>
          <p className="break-all text-xs text-muted-foreground">{selected.model} · {new Date(selected.created_at * 1000).toLocaleString("zh-CN")} · {selected.request_id}</p>
        </article>}
      </div>
      <div className="border-t p-4"><h2 className="mb-3 text-sm font-medium">视频历史</h2><div className="flex max-h-52 flex-col gap-2 overflow-y-auto">
        {!jobs.length && <p className="text-xs text-muted-foreground">{historyLoaded ? "暂无生成记录" : "正在加载记录…"}</p>}
        {jobs.map(job => <button key={job.request_id} type="button" aria-pressed={selected?.request_id === job.request_id} onClick={() => setSelectedId(job.request_id)} className="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm aria-pressed:border-primary aria-pressed:bg-primary/5"><span className="min-w-0 truncate">{job.prompt}</span><span className="shrink-0 text-xs text-muted-foreground">{statusText[job.status] || job.status}</span></button>)}
      </div></div>
    </div>
    <div className="video-form p-4 sm:p-5">
      {configError && <p role="alert" className="mb-4 text-sm text-amber-700">{configError}<Button variant="ghost" onClick={() => void loadConfig()}>重试加载模型</Button></p>}
      {config && !models.length && <p role="status" className="mb-4 rounded-lg border p-3 text-sm">{config.video_enabled ? "暂无可用视频模型，请联系管理员配置视频渠道" : "视频生成尚未开放"}</p>}
      <fieldset disabled={busy || !model || Boolean(configError)} className="space-y-4 disabled:opacity-60">
        <label className="block space-y-2 text-sm">视频模型<select aria-label="视频模型" className={selectClass} value={modelId} onChange={e => { changed(); clearReferences(); setMode("text"); setModelId(e.target.value); }}><option value="" disabled>选择视频模型</option>{models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <PersonalPrompts prompt={prompt} onApply={content => { const next = (prompt.trimEnd() ? prompt.trimEnd() + "\n" : "") + content; if (next.length > 8000) { toast.error("合并后的提示词超过 8000 字，请先精简内容"); return; } changed(); setPrompt(next); }} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="视频生成方式">
          {([['text','文生视频'],['image','图生视频'],['reference','参考素材']] as const).map(([value, label]) => <Button key={value} size="sm" variant={mode === value ? "default" : "outline"} aria-pressed={mode === value} disabled={value !== "text" && !model?.max_reference_images && !(value === "reference" && model?.supports_voice)} onClick={() => changeMode(value)}>{label}</Button>)}
        </div>
        <label className="block space-y-2 text-sm">视频提示词<Textarea aria-label="视频提示词" maxLength={8000} className="min-h-36 resize-y" placeholder="例如：清晨海边，女孩回头微笑，镜头缓慢推进，海浪声自然轻柔…" value={prompt} onChange={e => { changed(); setPrompt(e.target.value); }} /><span className="block text-right text-xs text-muted-foreground">{prompt.length}/8000</span></label>
        {mode !== "text" && Boolean(model?.max_reference_images) && <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed p-3 text-sm"><ImagePlus size={18} />{mode === "image" ? "添加首帧图片" : `添加参考图（${images.length}/${maxImages}）`}<input aria-label="上传视频参考图" type="file" accept="image/png,image/jpeg,image/webp" multiple={mode === "reference"} className="sr-only" disabled={busy || images.length >= maxImages} onChange={e => { void attach(Array.from(e.target.files || []), "image"); e.target.value = ""; }} /></label>
          <p className="text-xs text-muted-foreground">每张最多 5 MB。{mode === "image" ? "作为视频起始画面；Grok 输出比例跟随首帧。" : "按添加顺序描述素材的用途。"}</p>
          <div className="flex flex-wrap gap-2">{images.map((item, index) => <div key={item.id} className="relative"><img src={item.preview} alt={`参考图 ${index + 1}`} className="h-20 w-20 rounded-lg border object-cover" /><button aria-label={`移除参考图 ${index + 1}`} className="absolute right-0 top-0 rounded-full bg-background p-1" onClick={() => { changed(); release(item); setImages(images.filter(i => i.id !== item.id)); }}><X size={14} /></button></div>)}</div>
        </div>}
        {referenceMode && model?.supports_voice && <label className="block space-y-2 text-sm">参考音色<Input aria-label="参考音色" placeholder="例如 eve,leo（最多三个）" value={voice} onChange={e => { changed(); setGenerateAudio(true); setVoice(e.target.value); }} /><span className="block text-xs text-muted-foreground">预设音色 ID，在提示词中用 &lt;AUDIO_0&gt; 指定第一个声音。此模型不接受自有音频文件。</span></label>}
        {referenceMode && model?.supports_audio_upload && <div className="space-y-2"><label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed p-3 text-sm"><Music2 size={18} />添加参考音频<input aria-label="上传视频参考音频" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" className="sr-only" onChange={e => { setGenerateAudio(true); void attach(Array.from(e.target.files || []), "audio"); e.target.value = ""; }} /></label><p className="text-xs text-muted-foreground">MP3/WAV，2–15 秒，最多 20 MB；需搭配参考图。</p>{audio && <div className="space-y-2"><audio controls src={audio.preview} className="w-full" /><Button size="sm" variant="ghost" onClick={() => { changed(); release(audio); setAudio(null); }}><X size={14} />移除音频</Button></div>}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-2 text-sm">时长（秒）<Input aria-label="视频时长" type="number" min={model?.min_duration || 1} max={maxDuration} value={duration} onChange={e => { changed(); setDuration(Math.max(model?.min_duration || 1, Math.min(maxDuration, Math.trunc(Number(e.target.value) || 1)))); }} /></label>
          <label className="space-y-2 text-sm">清晰度<select aria-label="视频清晰度" className={selectClass} value={resolution} onChange={e => { changed(); setResolution(e.target.value); }}>{model?.resolutions.map(r => <option key={r}>{r}</option>)}</select></label>
          <label className="space-y-2 text-sm">画面比例<select aria-label="视频比例" className={selectClass} disabled={mode === "image" && model?.protocol === "grok"} value={ratio} onChange={e => { changed(); setRatio(e.target.value); }}>{ratios.map(r => <option key={r}>{r}</option>)}</select></label>
          <label className="flex items-center gap-2 self-end py-3 text-sm"><input type="checkbox" checked={generateAudio} disabled={Boolean(audio || voice.trim())} onChange={e => { changed(); setGenerateAudio(e.target.checked); }} />生成声音</label>
        </div>
        <div className="rounded-lg bg-muted/30 p-3 text-sm"><div className="flex justify-between"><span>预计积分</span><strong>{price}</strong></div><p className="mt-1 text-xs text-muted-foreground">提交前预扣，明确失败自动退回。{resolution === "720p" ? "720p 按两倍计费。" : ""}</p></div>
        {submitError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{submitError}；重试相同提交会复用任务，不会重复创建。</p>}
        {active && <p role="status" className="text-sm text-muted-foreground">{active.status === "unknown" ? "已有待核对任务，请联系管理员" : "已有视频正在生成，完成后可继续提交"}</p>}
        <Button className="w-full" disabled={busy || Boolean(active) || !prompt.trim() || !historyLoaded || Boolean(historyError) || (quota !== null && quota < price)} onClick={() => void submit()}>{busy ? <><LoaderCircle size={16} className="animate-spin" />{stage}</> : quota !== null && quota < price ? "积分不足" : <><Film size={16} />{submitError ? "重试提交" : "生成视频"}</>}</Button>
      </fieldset>
    </div>
  </section>;
}
