"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileImage, FileSliders, LoaderCircle, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchEditableFileTasks, type EditableFileTask } from "@/lib/api";
import { downloadStudioFile, generateStudio, getStudioConfig, getStudioJobs, getStudioPlan, getStudioPlans, optimizeStudioRequirement, planStudio, studioFile, type PlanResult, type StudioConfig, type StudioJob, type StudioKind, type StudioPlan, type StudioPlanTask } from "@/lib/editable-studio";
import { PlanEditor } from "./plan-editor";
import "./studio-docs.css";

type Reference = { name: string; data: string };
type Draft = { prompt: string; template: string; pages: number; layers: number; fill: boolean; images: Reference[]; savedImages: string[]; result: PlanResult | null; previousPlan?: string; submitted?: string; planTask?: StudioPlanTask; appliedTask?: string; optimization?: { text: string; original: string; truncated: boolean }; undoPrompt?: string };
const blank = (): Draft => ({ prompt: "", template: "business", pages: 8, layers: 12, fill: false, images: [], savedImages: [], result: null, previousPlan: undefined, submitted: undefined, planTask: undefined, appliedTask: undefined, optimization: undefined, undoPrompt: undefined });
const statusNames: Record<string, string> = { queued: "排队中", running: "制作中", success: "已完成", error: "失败已退款" };
const errText = (e: unknown) => e instanceof Error ? e.message : "操作失败，请重试";
const planning = (task?: StudioPlanTask) => !!task && ["preparing", "queued", "running"].includes(task.status);
function mergePlanTasks(current: StudioPlanTask[], incoming: StudioPlanTask[]) {
  const tasks = new Map(current.map(task => [task.id, task]));
  for (const task of incoming) {
    const old = tasks.get(task.id);
    if (!old || planning(old) || !planning(task)) tasks.set(task.id, task);
  }
  return [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function applyPlanTask(draft: Draft, task: StudioPlanTask, restore = false): Draft {
  if (!restore && draft.planTask?.id === task.id && !planning(draft.planTask) && planning(task)) return draft;
  const next = restore ? { ...blank(), prompt: task.request.prompt, template: task.request.template_id, pages: task.request.page_count, layers: task.request.layer_count, fill: task.request.fill_background, previousPlan: task.request.previous_plan_id || undefined } : { ...draft };
  next.planTask = task;
  if (!next.images.length) next.savedImages = task.reference_urls;
  if (task.result && !task.expired && next.appliedTask !== task.id) {
    next.result = task.result; next.previousPlan = task.result.plan_id; next.appliedTask = task.id; next.submitted = task.submitted_job_id || undefined;
  }
  return next;
}

function usePrivateImage(path: string) {
  const [source, setSource] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    let active = true, url = "";
    setSource(""); setError("");
    if (path) studioFile(path).then(blob => { if (active) { url = URL.createObjectURL(blob); setSource(url); } }).catch(e => { if (active) setError(errText(e)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return { source, error };
}
function PrivateImage({ path, alt }: { path: string; alt: string }) {
  const { source, error } = usePrivateImage(path);
  return source ? <img src={source} alt={alt} loading="lazy" /> : <div className="doc-preview-loading">{error || "正在读取预览…"}</div>;
}

export default function EditableStudioPage() {
  const [kind, setKind] = useState<StudioKind>("ppt");
  const [drafts, setDrafts] = useState<Record<StudioKind, Draft>>({ ppt: blank(), psd: blank() });
  const draft = drafts[kind];
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]); const [legacy, setLegacy] = useState<EditableFileTask[]>([]);
  const [planTasks, setPlanTasks] = useState<StudioPlanTask[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false); const [pollError, setPollError] = useState("");
  const [selected, setSelected] = useState(""); const [busy, setBusy] = useState("");
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const submitKey = useRef({ fingerprint: "", key: "" }); const mounted = useRef(true);
  const planSubmitKey = useRef({ fingerprint: "", key: "" }); const plansRestored = useRef(false);
  const patch = (values: Partial<Draft>, invalidate = false) => setDrafts(all => ({ ...all, [kind]: { ...all[kind], ...(values.prompt !== undefined ? { optimization: undefined, undoPrompt: undefined } : {}), ...values, ...(invalidate ? { result: null, submitted: undefined } : {}) } }));
  const limits = config?.limits; const active = jobs.find(j => j.id === selected && j.kind === kind) || null;
  const activeJobs = jobs.some(j => ["queued", "running"].includes(j.status));
  const isPlanning = planning(draft.planTask); const anyPlanning = planTasks.some(planning);
  const pendingPlans = planTasks.filter(planning).map(t => t.id).sort().join(",");
  const { source: savedImage } = usePrivateImage(draft.savedImages[0] || "");
  const updatePlanTask = useCallback((task: StudioPlanTask, attach = false) => {
    if (!mounted.current) return;
    setPlanTasks(all => mergePlanTasks(all, [task]));
    setDrafts(all => !attach && all[task.kind].planTask?.id !== task.id ? all : { ...all, [task.kind]: applyPlanTask(all[task.kind], task) });
  }, []);
  const refreshPlans = useCallback(async () => {
    try {
      const { items } = await getStudioPlans();
      if (!mounted.current) return;
      const restore = !plansRestored.current; plansRestored.current = true;
      setPlanTasks(all => mergePlanTasks(all, items)); setPlansLoaded(true); setPollError("");
      setDrafts(all => {
        const next = { ...all };
        for (const k of ["ppt", "psd"] as const) {
          const current = all[k];
          const task = current.planTask ? items.find(t => t.id === current.planTask?.id) : restore && !current.prompt && !current.images.length ? items.find(t => t.kind === k && !t.expired) : undefined;
          if (task) next[k] = applyPlanTask(current, task, !current.planTask);
        }
        return next;
      });
    } catch { if (mounted.current) setPollError("暂时无法查询方案生成任务，请点击刷新任务；不要重复提交新任务。"); }
  }, []);
  const refresh = useCallback(async () => { try { const data = await getStudioJobs(); if (mounted.current) setJobs(data.items); } catch (e) { if (mounted.current) setError(errText(e)); } }, []);
  useEffect(() => {
    mounted.current = true;
    getStudioConfig().then(c => { if (mounted.current) setConfig(c); }).catch(e => { if (mounted.current) setError(errText(e)); });
    void refresh(); void refreshPlans(); fetchEditableFileTasks().then(r => { if (mounted.current) setLegacy(r.items); }).catch(() => {});
    return () => { mounted.current = false; };
  }, [refresh, refreshPlans]);
  useEffect(() => { if (!activeJobs) return; const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [activeJobs, refresh]);
  useEffect(() => {
    if (!pendingPlans) return;
    let cancelled = false, timer: number | undefined, failures = 0;
    const poll = async () => {
      const results = await Promise.allSettled(pendingPlans.split(",").map(id => getStudioPlan(id)));
      if (cancelled) return;
      let failed = false, active = false;
      for (const result of results) {
        if (result.status === "fulfilled") { updatePlanTask(result.value); active ||= planning(result.value); }
        else { failed = true; active = true; }
      }
      failures = failed ? failures + 1 : 0;
      setPollError(failed ? "进度查询暂时中断，正在自动重试；后台任务不会因此停止。" : "");
      if (active) timer = window.setTimeout(() => void poll(), Math.min(15000, 3000 * 2 ** Math.min(failures, 3)));
    };
    void poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [pendingPlans, updatePlanTask]);

  const upload = async (files: FileList | null) => {
    if (!files || !limits) return;
    setError(""); const max = kind === "psd" ? 1 : limits.max_reference_images; const incoming = Array.from(files);
    if (draft.images.length + incoming.length > max) { setError("最多上传 " + max + " 张图片；替换原图前请先移除旧图。"); return; }
    setBusy("upload");
    try {
      const refs = await Promise.all(incoming.map(file => new Promise<Reference>((resolve, reject) => {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > limits.max_image_mb * 1024 * 1024) { reject(new Error("仅支持 PNG/JPEG/WebP，每张最多 " + limits.max_image_mb + " MB")); return; }
        const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, data: String(reader.result) }); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(file);
      })));
      patch({ images: [...draft.images, ...refs], savedImages: [] }, true);
    } catch (e) { setError(errText(e)); } finally { setBusy(""); }
  };
  const optimizeRequirement = async () => {
    if (busy || isPlanning || !draft.prompt.trim() || !config?.optimization?.enabled) return;
    setBusy("optimize"); setError(""); setNotice("");
    try {
      const result = await optimizeStudioRequirement(kind, draft.prompt);
      if (mounted.current) patch({ optimization: { text: result.optimized_prompt, original: draft.prompt, truncated: result.truncated } });
    } catch (e) { if (mounted.current) setError(errText(e) + "。原文已保留，可以跳过优化，直接生成方案。"); }
    finally { if (mounted.current) setBusy(""); }
  };
  const createPlan = async () => {
    if (busy || anyPlanning || draft.optimization) return;
    const count = kind === "ppt" ? draft.pages : draft.layers;
    const minimum = kind === "ppt" ? 3 : 2;
    const maximum = kind === "ppt" ? limits?.max_pages || 20 : limits?.max_layers || 30;
    if (!Number.isInteger(count) || count < minimum || count > maximum) { setError(`${kind === "ppt" ? "PPT 页数" : "总图层数（含背景）"}必须是 ${minimum}–${maximum} 之间的整数。`); return; }
    if (!draft.prompt.trim() || (kind === "psd" && draft.images.length !== 1 && !(draft.previousPlan && draft.savedImages.length === 1))) { setError(kind === "psd" ? "请上传一张原图并描述需要拆分的元素。" : "请描述 PPT 的主题和用途。"); return; }
    const body = { kind, prompt: draft.prompt, template_id: draft.template, page_count: draft.pages, layer_count: draft.layers, fill_background: draft.fill, base64_images: draft.images.map(x => x.data), previous_plan_id: draft.previousPlan || null };
    const fingerprint = JSON.stringify(body);
    if (planSubmitKey.current.fingerprint !== fingerprint) planSubmitKey.current = { fingerprint, key: crypto.randomUUID() };
    const clientId = planSubmitKey.current.key;
    setBusy("plan"); setError(""); setNotice("");
    try {
      const task = await planStudio({ ...body, client_task_id: clientId });
      updatePlanTask(task, true); planSubmitKey.current = { fingerprint: "", key: "" };
      setNotice("方案生成已提交到后台，关闭或刷新页面后仍可查看进度；此阶段不扣生成积分。");
    } catch (e) {
      // An interrupted submission may have succeeded: recover its receipt first.
      try {
        const { items } = await getStudioPlans(); const recovered = items.find(t => t.client_task_id === clientId);
        if (recovered) { updatePlanTask(recovered, true); planSubmitKey.current = { fingerprint: "", key: "" }; setNotice("已找回后台任务，正在查询进度；没有重复提交。"); }
        else setError(errText(e) + "；可再次点击重试，同一提交不会重复创建任务。");
      } catch { setError(errText(e) + "；提交状态暂未确认，重试不会重复创建任务。"); }
    } finally { if (mounted.current) setBusy(""); }
  };
  const editPlan = (next: StudioPlan) => { if (draft.result) patch({ result: { ...draft.result, plan: next }, submitted: undefined }); };
  const plan = draft.result?.plan; const price = plan && limits ? kind === "ppt" ? plan.slides.length * limits.ppt_page_price : limits.psd_task_price : 0;
  const submit = async () => {
    if (!draft.result || !plan || draft.optimization || busy) return;
    if (!plan.title.trim()) { setError("请填写文件标题。"); return; }
    if (kind === "ppt" && plan.slides.some(s => !s.title.trim() || s.body.length > 5 || s.body.some(t => t.length > 180))) { setError("请填写每页标题；每页正文最多 5 条，每条不要超过 180 字。原文已保留，请调整后提交。"); return; }
    if (kind === "psd") {
      const invalid = plan.layers.findIndex(l => { const [x, y, w, h] = l.box; return !l.name.trim() || l.box.some(v => !Number.isInteger(v)) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1000 || y + h > 1000; });
      if (invalid >= 0) { setError(`请检查图层 ${invalid + 1}：名称不能为空；坐标须为整数、宽高大于 0，且左 + 宽、上 + 高均不能超过 1000。`); return; }
      if (plan.layers.length + 1 > Math.min(draft.layers, limits?.max_layers || 30)) { setError("确认方案超过本次总图层上限（含背景），请删除多余图层后重试。"); return; }
    }
    const fingerprint = JSON.stringify({ id: draft.result.plan_id, plan });
    if (submitKey.current.fingerprint !== fingerprint) submitKey.current = { fingerprint, key: crypto.randomUUID() };
    setBusy("submit"); setError(""); setNotice("");
    try { const job = await generateStudio({ plan_id: draft.result.plan_id, plan, expected_price: price, client_task_id: submitKey.current.key }); patch({ submitted: job.id }); setSelected(job.id); setJobs(all => [job, ...all.filter(j => j.id !== job.id)]); setNotice("任务已提交，关闭页面后仍会继续。失败会自动退还积分。"); submitKey.current = { fingerprint: "", key: "" }; }
    catch (e) { setError(errText(e)); } finally { setBusy(""); }
  };
  const download = async (url: string, name: string) => { try { setError(""); await downloadStudioFile(url, name); } catch (e) { setError(errText(e)); } };

  return <main className="doc-studio">
    <header className="doc-heading"><div><p className="doc-eyebrow">EDITABLE STUDIO · API</p><h1>把想法，变成可用的文件</h1><p>先确认方案，再开始制作。PPT 可编辑，PSD 真分层。</p></div><Button variant="outline" onClick={() => { void refresh(); void refreshPlans(); }} aria-label="刷新文档任务"><RefreshCw className="size-4" />刷新任务</Button></header>
    <div className="doc-tabs" role="tablist" aria-label="文件类型"><button role="tab" aria-selected={kind === "ppt"} onClick={() => setKind("ppt")} disabled={!!busy}><FileSliders size={18} />PPT 演示文稿</button><button role="tab" aria-selected={kind === "psd"} onClick={() => setKind("psd")} disabled={!!busy}><FileImage size={18} />PSD 智能拆分</button></div>
    {error && <div className="doc-alert" role="alert">{error}</div>}{notice && <div className="doc-notice" role="status">{notice}</div>}
    {pollError && <div className="doc-notice" role="status">{pollError}</div>}
    {!config ? <p>正在读取工作室配置…</p> : !config.enabled ? <div className="doc-notice">工作室尚未启用，请管理员在系统设置中配置 API。历史文件仍可下载。</div> : null}
    <div className="doc-columns"><section className="doc-card doc-compose">
      <div className="doc-section-title"><div><span>01</span><h2>{kind === "ppt" ? "描述你的演示文稿" : "上传原图，说明拆分要求"}</h2></div><button className="doc-text-button" disabled={!!busy || isPlanning} onClick={() => { patch(blank()); planSubmitKey.current = { fingerprint: "", key: "" }; setError(""); setNotice(""); }}><Plus size={14} />新草稿</button></div>
      <fieldset disabled={!config?.enabled || !!busy || isPlanning}>
        {kind === "ppt" && <><div className="doc-templates" aria-label="PPT 模板">{config?.templates.map(t => <button key={t.id} aria-pressed={draft.template === t.id} onClick={() => patch({ template: t.id }, true)} className="doc-template"><img src={"/studio-templates/" + t.id + "/slide-1.png"} alt={t.name + "封面预览"} /><strong>{t.name}</strong><span>{t.description}</span></button>)}</div><details className="doc-template-detail"><summary>查看所选模板的内容页与图表页</summary><div>{[2, 3].map(n => <img key={n} src={"/studio-templates/" + draft.template + "/slide-" + n + ".png"} alt={n === 2 ? "模板内容页预览" : "模板图表页预览"} />)}</div></details></>}
        <label className="doc-label" htmlFor="doc-prompt">{kind === "ppt" ? "主题、受众与必须包含的内容" : "要分开的元素，以及必须保留的细节"}</label>
        <textarea id="doc-prompt" maxLength={8000} value={draft.prompt} onChange={e => patch({ prompt: e.target.value }, true)} placeholder={kind === "ppt" ? "例如：给经销商看的产品介绍，重点是产品特点、应用场景和合作方式。没有提供的数据请标注待补充。" : "例如：背景、产品、标题、Logo 分开，保持原位置，不要重绘商品。"} />
        <div className="doc-inline-fields">{kind === "ppt" ? <label>页数<input aria-label="PPT 页数" type="number" min={3} max={limits?.max_pages || 20} value={draft.pages} onChange={e => patch({ pages: Number(e.target.value) }, true)} /></label> : <><label>最多图层（含背景）<input aria-label="最多图层" type="number" min={2} max={limits?.max_layers || 30} value={draft.layers} onChange={e => patch({ layers: Number(e.target.value) }, true)} /></label><label className="doc-checkbox"><input type="checkbox" checked={draft.fill} onChange={e => patch({ fill: e.target.checked }, true)} />近似修补被遮挡背景</label></>}</div>
        <label className="doc-upload">{kind === "ppt" ? "上传 Logo / 产品图（选填）" : "上传一张原图（必填）"}<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" multiple={kind === "ppt"} onChange={e => { void upload(e.target.files); e.target.value = ""; }} /><small>每张 ≤ {limits?.max_image_mb || 10} MB，≤ {Math.round((limits?.max_image_pixels || 16000000) / 1000000)} 百万像素</small></label>
        <div className="doc-references">{draft.images.map((ref, i) => <div key={i}><img src={ref.data} alt={ref.name} /><button aria-label={"移除参考图 " + (i + 1)} onClick={() => patch({ images: draft.images.filter((_, n) => n !== i) }, true)}><Trash2 size={14} /></button><span>{ref.name}</span></div>)}</div>
        {!draft.images.length && draft.savedImages.length > 0 && <><div className="doc-references">{draft.savedImages.map((path, i) => <div key={path}><PrivateImage path={path} alt={"已保存的参考图 " + (i + 1)} /><span>已保存的参考图 {i + 1}</span></div>)}</div><p className="doc-help">已恢复上次的素材，重新生成方案时会复用。上传新图可替换素材。</p></>}
      </fieldset>
      {kind === "psd" && <><p className="doc-help">图层数包含 1 个自动背景层：设置 12 层时，最多拆出 11 个前景层，不要求凑满。后台上限不会扩大你为本次任务设置的数量。</p><p className="doc-help">优先保留原图像素与位置。文字是可移动的像素层，不是字体层；平面图不包含原始隐藏图层。不开启修补时，遮挡区域保留透明。</p></>}
      <div className="doc-requirement-actions">
        <Button variant="outline" disabled={!config?.enabled || !config?.optimization?.enabled || !!busy || isPlanning || !!draft.optimization || !draft.prompt.trim()} onClick={() => void optimizeRequirement()}>{busy === "optimize" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{busy === "optimize" ? "正在优化文字…" : "优化需求"}</Button>
        <Button className="doc-primary" disabled={!config?.enabled || !plansLoaded || !!busy || anyPlanning || !!draft.optimization || !draft.prompt.trim()} onClick={() => void createPlan()}>{busy === "plan" || isPlanning ? <LoaderCircle className="size-4 animate-spin" /> : <FileSliders className="size-4" />}{busy === "plan" ? "正在提交后台任务…" : isPlanning ? "后台正在生成方案…" : "生成方案"}</Button>
      </div>
      <p className="doc-help">优化需求：只润色文字，不分析图片；可跳过。生成方案：按当前需求在后台生成{kind === "ppt" ? "逐页大纲" : "图层拆分方案"}，不会直接制作文件。</p>
      {config?.optimization?.enabled ? <p className="doc-help">文本优化与绘图提示词优化共享额度：每账号 {config.optimization.user_rpm} 次/分钟、{config.optimization.user_daily_requests} 次/天；输入 ≤ {config.optimization.max_input_tokens} token（含指令），输出 ≤ {config.optimization.max_output_tokens} token，上游请求最多等待 {config.optimization.timeout_seconds} 秒。不扣生成积分。</p> : config?.enabled && <p className="doc-help">文本优化尚未启用，请管理员配置并开启“提示词优化 API”；仍可直接生成方案。</p>}
      {draft.optimization && <section className="doc-optimization" aria-labelledby="doc-optimization-title"><h3 id="doc-optimization-title">优化建议 · 待你确认</h3><p className="doc-help">原文未改动。可编辑建议，再选择采用或保留原文；不会自动生成方案。</p><label className="doc-label" htmlFor="doc-optimized-prompt">优化后的需求</label><textarea id="doc-optimized-prompt" maxLength={8000} value={draft.optimization.text} disabled={!!busy || isPlanning} onChange={e => patch({ optimization: { ...draft.optimization!, text: e.target.value } })} />{draft.optimization.truncated && <p className="doc-help" role="status">优化结果已达输出上限，可能不完整，请检查补充后再采用。</p>}<div className="doc-requirement-actions"><Button disabled={!!busy || isPlanning || !draft.optimization.text.trim()} onClick={() => { patch({ prompt: draft.optimization!.text, undoPrompt: draft.optimization!.original, optimization: undefined }, true); setNotice("已采用优化结果，可继续编辑；点击“生成方案”后才会创建后台任务。"); }}>采用优化结果</Button><Button variant="outline" disabled={!!busy || isPlanning} onClick={() => patch({ optimization: undefined })}>保留原文</Button></div></section>}
      {draft.undoPrompt !== undefined && !draft.optimization && <button className="doc-text-button doc-undo" disabled={!!busy || isPlanning} onClick={() => { patch({ prompt: draft.undoPrompt! }, true); setNotice("已恢复优化前的原文。"); }}>撤销优化</button>}
      {draft.planTask && <div className="doc-plan-progress" role="status" aria-live="polite"><strong>{draft.planTask.phase}</strong><span>已用时 {Math.floor(draft.planTask.elapsed_seconds / 60)} 分 {draft.planTask.elapsed_seconds % 60} 秒</span>{isPlanning && <p><LoaderCircle className="size-4 animate-spin" />后台执行中，关闭或刷新页面后可继续查看。</p>}{draft.planTask.status === "success" && <p>方案已就绪，请检查内容后再确认生成。</p>}{draft.planTask.error && <p className="doc-plan-error">{draft.planTask.error}。此阶段未扣生成积分，可调整后重新提交。</p>}</div>}
      {anyPlanning && !isPlanning && <p className="doc-help">已有方案在后台生成，请等待完成后再提交新方案。</p>}
      <p className="doc-help">方案生成：每账号 {limits?.plan_user_rpm ?? 3} 次/分钟、{limits?.plan_daily_requests ?? 20} 次/天；每草稿最多 {limits?.plan_revisions ?? 3} 次 AI 方案。不扣生成积分。</p>
      {plan && <section className="doc-plan"><div className="doc-section-title"><div><span>02</span><h2>检查并修改制作方案</h2></div><small>第 {draft.result?.revision} 次方案</small></div><PlanEditor plan={plan} change={editPlan} image={draft.images[0]?.data || savedImage} disabled={!!busy || isPlanning || !!draft.submitted} />
        <div className="doc-confirm"><div><strong>预计 {price} 积分</strong><span>{kind === "ppt" ? plan.slides.length + " 页 · 文字与基础元素可编辑" : (plan.layers.length + 1) + " 个图层（含背景） · PSD + 透明素材"}</span></div><Button className="doc-primary" disabled={!!busy || isPlanning || !!draft.submitted || !!draft.optimization} onClick={() => void submit()}>{busy === "submit" && <LoaderCircle className="size-4 animate-spin" />}{draft.submitted ? "已提交制作" : "确认方案并生成"}</Button></div>
        <p className="doc-help">确认后预扣积分；提交重试不会重复扣费，生成失败自动退款。文件保留 {limits?.retention_days || 7} 天。</p>
        {draft.submitted && jobs.find(j => j.id === draft.submitted)?.status === "error" && <Button variant="outline" onClick={() => patch({ submitted: undefined })}>保留方案，重新制作</Button>}
      </section>}
    </section><aside className="doc-side">
      {planTasks.length > 0 && <section className="doc-card"><h2>方案生成记录</h2><p className="doc-help">最近 24 小时的任务，点击可恢复需求、素材和方案。</p><div className="doc-job-list">{planTasks.map(task => <button key={task.id} className={draft.planTask?.id === task.id ? "selected" : ""} disabled={!!busy || task.expired} onClick={() => { setKind(task.kind); setDrafts(all => ({ ...all, [task.kind]: applyPlanTask(all[task.kind], task, true) })); setError(""); setNotice(""); }}><strong>{task.kind.toUpperCase()} · {task.request.prompt}</strong><span>{task.phase} · {task.elapsed_seconds} 秒</span></button>)}</div></section>}
      <section className="doc-card"><div className="doc-section-title"><div><span>03</span><h2>任务与交付</h2></div></div><div className="doc-job-list">{jobs.filter(j => j.kind === kind).length ? jobs.filter(j => j.kind === kind).map(job => <button key={job.id} className={selected === job.id ? "selected" : ""} onClick={() => setSelected(job.id)}><strong>{job.title}</strong><span>{statusNames[job.status] || job.status} · {job.price} 积分</span></button>) : <p className="doc-help">还没有任务。确认左侧方案后，制作进度会出现在这里。</p>}</div></section>
      {active && <section className="doc-card doc-delivery"><h2>{active.title}</h2><p className="doc-help">{active.phase} · {Math.floor(active.elapsed_seconds / 60)} 分 {active.elapsed_seconds % 60} 秒</p>{active.error && <div className="doc-alert">{active.error}</div>}{["queued", "running"].includes(active.status) && <p className="doc-running"><LoaderCircle className="size-5 animate-spin" />任务在后台执行，关闭页面后仍会继续。</p>}{active.expired ? <div className="doc-notice">文件已超过保留期限，任务记录仍保留。</div> : active.result && <><div className="doc-downloads"><Button onClick={() => void download(active.result!.primary_url, active.kind === "ppt" ? "presentation.pptx" : "layers.psd")}><Download className="size-4" />下载 {active.kind.toUpperCase()}</Button><Button variant="outline" onClick={() => void download(active.result!.zip_url, "assets.zip")}>下载素材包</Button></div>{active.result.warnings.map((w, i) => <p className="doc-help" key={i}>{w}</p>)}{active.result.original_url && <details><summary>查看原图，核对拆分效果</summary><PrivateImage path={active.result.original_url} alt="PSD 原图" /></details>}{active.result.previews.map((url, i) => <figure key={url}><PrivateImage path={url} alt={active.kind === "ppt" ? "实际生成的第 " + (i + 1) + " 页" : "PSD 图层合成预览"} /><figcaption>{active.kind === "ppt" ? "第 " + (i + 1) + " 页 · 实际文件渲染" : "图层合成预览；请核对边缘与元素归属"}</figcaption></figure>)}</>}</section>}
      {legacy.length > 0 && <details className="doc-card"><summary>旧版账号任务历史（{legacy.length}）</summary>{legacy.slice(0, 30).map(job => <div className="doc-legacy" key={job.id || job.taskId}><span>{job.kind.toUpperCase()} · {job.created_at} · {statusNames[job.status] || job.status}</span>{job.result?.primary_url && <button onClick={() => void download(job.result!.primary_url!, job.kind === "ppt" ? "legacy.pptx" : "legacy.psd")}>下载文件</button>}{job.result?.zip_url && <button onClick={() => void download(job.result!.zip_url!, "legacy-assets.zip")}>素材包</button>}</div>)}</details>}
    </aside></div>
  </main>;
}
