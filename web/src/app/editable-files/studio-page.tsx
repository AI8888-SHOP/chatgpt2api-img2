"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileImage, FileSliders, LoaderCircle, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchEditableFileTasks, type EditableFileTask } from "@/lib/api";
import { downloadStudioFile, generateStudio, getStudioConfig, getStudioJobs, planStudio, studioFile, type PlanResult, type StudioConfig, type StudioJob, type StudioKind, type StudioPlan } from "@/lib/editable-studio";
import { PlanEditor } from "./plan-editor";
import "./studio-docs.css";

type Reference = { name: string; data: string };
type Draft = { prompt: string; template: string; pages: number; layers: number; fill: boolean; images: Reference[]; result: PlanResult | null; previousPlan?: string; submitted?: string };
const blank = (): Draft => ({ prompt: "", template: "business", pages: 8, layers: 12, fill: false, images: [], result: null, previousPlan: undefined, submitted: undefined });
const statusNames: Record<string, string> = { queued: "排队中", running: "制作中", success: "已完成", error: "失败已退款" };
const errText = (e: unknown) => e instanceof Error ? e.message : "操作失败，请重试";

function PrivateImage({ path, alt }: { path: string; alt: string }) {
  const [source, setSource] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    let active = true, url = "";
    setSource(""); setError("");
    studioFile(path).then(blob => { if (active) { url = URL.createObjectURL(blob); setSource(url); } }).catch(e => { if (active) setError(errText(e)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return source ? <img src={source} alt={alt} loading="lazy" /> : <div className="doc-preview-loading">{error || "正在读取预览…"}</div>;
}

export default function EditableStudioPage() {
  const [kind, setKind] = useState<StudioKind>("ppt");
  const [drafts, setDrafts] = useState<Record<StudioKind, Draft>>({ ppt: blank(), psd: blank() });
  const draft = drafts[kind];
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]); const [legacy, setLegacy] = useState<EditableFileTask[]>([]);
  const [selected, setSelected] = useState(""); const [busy, setBusy] = useState("");
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const submitKey = useRef({ fingerprint: "", key: "" }); const mounted = useRef(true);
  const patch = (values: Partial<Draft>, invalidate = false) => setDrafts(all => ({ ...all, [kind]: { ...all[kind], ...values, ...(invalidate ? { result: null, submitted: undefined } : {}) } }));
  const limits = config?.limits; const active = jobs.find(j => j.id === selected && j.kind === kind) || null;
  const activeJobs = jobs.some(j => ["queued", "running"].includes(j.status));
  const refresh = useCallback(async () => { try { const data = await getStudioJobs(); if (mounted.current) setJobs(data.items); } catch (e) { if (mounted.current) setError(errText(e)); } }, []);
  useEffect(() => {
    mounted.current = true;
    getStudioConfig().then(c => { if (mounted.current) setConfig(c); }).catch(e => { if (mounted.current) setError(errText(e)); });
    void refresh(); fetchEditableFileTasks().then(r => { if (mounted.current) setLegacy(r.items); }).catch(() => {});
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => { if (!activeJobs) return; const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [activeJobs, refresh]);

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
      patch({ images: [...draft.images, ...refs] }, true);
    } catch (e) { setError(errText(e)); } finally { setBusy(""); }
  };
  const createPlan = async () => {
    if (!draft.prompt.trim() || (kind === "psd" && draft.images.length !== 1)) { setError(kind === "psd" ? "请上传一张原图并描述需要拆分的元素。" : "请描述 PPT 的主题和用途。"); return; }
    setBusy("plan"); setError(""); setNotice("");
    try { const result = await planStudio({ kind, prompt: draft.prompt, template_id: draft.template, page_count: draft.pages, layer_count: draft.layers, fill_background: draft.fill, base64_images: draft.images.map(x => x.data), previous_plan_id: draft.previousPlan || null }); patch({ result, previousPlan: result.plan_id, submitted: undefined }); setNotice("制作方案已整理，请检查内容后再确认生成。"); }
    catch (e) { setError(errText(e)); } finally { setBusy(""); }
  };
  const editPlan = (next: StudioPlan) => { if (draft.result) patch({ result: { ...draft.result, plan: next }, submitted: undefined }); };
  const plan = draft.result?.plan; const price = plan && limits ? kind === "ppt" ? plan.slides.length * limits.ppt_page_price : limits.psd_task_price : 0;
  const submit = async () => {
    if (!draft.result || !plan) return;
    const fingerprint = JSON.stringify({ id: draft.result.plan_id, plan });
    if (submitKey.current.fingerprint !== fingerprint) submitKey.current = { fingerprint, key: crypto.randomUUID() };
    setBusy("submit"); setError(""); setNotice("");
    try { const job = await generateStudio({ plan_id: draft.result.plan_id, plan, expected_price: price, client_task_id: submitKey.current.key }); patch({ submitted: job.id }); setSelected(job.id); setJobs(all => [job, ...all.filter(j => j.id !== job.id)]); setNotice("任务已提交，关闭页面后仍会继续。失败会自动退还积分。"); submitKey.current = { fingerprint: "", key: "" }; }
    catch (e) { setError(errText(e)); } finally { setBusy(""); }
  };
  const download = async (url: string, name: string) => { try { setError(""); await downloadStudioFile(url, name); } catch (e) { setError(errText(e)); } };

  return <main className="doc-studio">
    <header className="doc-heading"><div><p className="doc-eyebrow">EDITABLE STUDIO · API</p><h1>把想法，变成可用的文件</h1><p>先确认方案，再开始制作。PPT 可编辑，PSD 真分层。</p></div><Button variant="outline" onClick={() => void refresh()} aria-label="刷新文档任务"><RefreshCw className="size-4" />刷新任务</Button></header>
    <div className="doc-tabs" role="tablist" aria-label="文件类型"><button role="tab" aria-selected={kind === "ppt"} onClick={() => setKind("ppt")} disabled={!!busy}><FileSliders size={18} />PPT 演示文稿</button><button role="tab" aria-selected={kind === "psd"} onClick={() => setKind("psd")} disabled={!!busy}><FileImage size={18} />PSD 智能拆分</button></div>
    {error && <div className="doc-alert" role="alert">{error}</div>}{notice && <div className="doc-notice" role="status">{notice}</div>}
    {!config ? <p>正在读取工作室配置…</p> : !config.enabled ? <div className="doc-notice">工作室尚未启用，请管理员在系统设置中配置 API。历史文件仍可下载。</div> : null}
    <div className="doc-columns"><section className="doc-card doc-compose">
      <div className="doc-section-title"><div><span>01</span><h2>{kind === "ppt" ? "描述你的演示文稿" : "上传原图，说明拆分要求"}</h2></div><button className="doc-text-button" disabled={!!busy} onClick={() => { patch(blank()); setError(""); setNotice(""); }}><Plus size={14} />新草稿</button></div>
      <fieldset disabled={!config?.enabled || !!busy}>
        {kind === "ppt" && <><div className="doc-templates" aria-label="PPT 模板">{config?.templates.map(t => <button key={t.id} aria-pressed={draft.template === t.id} onClick={() => patch({ template: t.id }, true)} className="doc-template"><img src={"/studio-templates/" + t.id + "/slide-1.png"} alt={t.name + "封面预览"} /><strong>{t.name}</strong><span>{t.description}</span></button>)}</div><details className="doc-template-detail"><summary>查看所选模板的内容页与图表页</summary><div>{[2, 3].map(n => <img key={n} src={"/studio-templates/" + draft.template + "/slide-" + n + ".png"} alt={n === 2 ? "模板内容页预览" : "模板图表页预览"} />)}</div></details></>}
        <label className="doc-label" htmlFor="doc-prompt">{kind === "ppt" ? "主题、受众与必须包含的内容" : "要分开的元素，以及必须保留的细节"}</label>
        <textarea id="doc-prompt" maxLength={8000} value={draft.prompt} onChange={e => patch({ prompt: e.target.value }, true)} placeholder={kind === "ppt" ? "例如：给经销商看的产品介绍，重点是产品特点、应用场景和合作方式。没有提供的数据请标注待补充。" : "例如：背景、产品、标题、Logo 分开，保持原位置，不要重绘商品。"} />
        <div className="doc-inline-fields">{kind === "ppt" ? <label>页数<input aria-label="PPT 页数" type="number" min={3} max={limits?.max_pages || 20} value={draft.pages} onChange={e => patch({ pages: Number(e.target.value) }, true)} /></label> : <><label>最多图层（含背景）<input aria-label="最多图层" type="number" min={2} max={limits?.max_layers || 30} value={draft.layers} onChange={e => patch({ layers: Number(e.target.value) }, true)} /></label><label className="doc-checkbox"><input type="checkbox" checked={draft.fill} onChange={e => patch({ fill: e.target.checked }, true)} />近似修补被遮挡背景</label></>}</div>
        <label className="doc-upload">{kind === "ppt" ? "上传 Logo / 产品图（选填）" : "上传一张原图（必填）"}<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" multiple={kind === "ppt"} onChange={e => { void upload(e.target.files); e.target.value = ""; }} /><small>每张 ≤ {limits?.max_image_mb || 10} MB，≤ {Math.round((limits?.max_image_pixels || 16000000) / 1000000)} 百万像素</small></label>
        <div className="doc-references">{draft.images.map((ref, i) => <div key={i}><img src={ref.data} alt={ref.name} /><button aria-label={"移除参考图 " + (i + 1)} onClick={() => patch({ images: draft.images.filter((_, n) => n !== i) }, true)}><Trash2 size={14} /></button><span>{ref.name}</span></div>)}</div>
      </fieldset>
      {kind === "psd" && <p className="doc-help">优先保留原图像素与位置。文字是可移动的像素层，不是字体层；平面图不包含原始隐藏图层。不开启修补时，遮挡区域保留透明。</p>}
      <Button className="doc-primary" disabled={!config?.enabled || !!busy || !draft.prompt.trim()} onClick={() => void createPlan()}>{busy === "plan" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{busy === "plan" ? "AI 正在整理，请稍候…" : draft.previousPlan ? "按新要求重新整理" : "帮我完善需求并生成方案"}</Button>
      <p className="doc-help">每账号 {limits?.plan_user_rpm ?? 3} 次/分钟、{limits?.plan_daily_requests ?? 20} 次/天；每草稿最多 {limits?.plan_revisions ?? 3} 次 AI 整理。此阶段不扣生成积分。</p>
      {plan && <section className="doc-plan"><div className="doc-section-title"><div><span>02</span><h2>检查并修改制作方案</h2></div><small>第 {draft.result?.revision} 次整理</small></div><PlanEditor plan={plan} change={editPlan} image={draft.images[0]?.data} disabled={!!busy || !!draft.submitted} />
        <div className="doc-confirm"><div><strong>预计 {price} 积分</strong><span>{kind === "ppt" ? plan.slides.length + " 页 · 文字与基础元素可编辑" : (plan.layers.length + 1) + " 个图层（含背景） · PSD + 透明素材"}</span></div><Button className="doc-primary" disabled={!!busy || !!draft.submitted} onClick={() => void submit()}>{busy === "submit" && <LoaderCircle className="size-4 animate-spin" />}{draft.submitted ? "已提交制作" : "确认方案并生成"}</Button></div>
        <p className="doc-help">确认后预扣积分；提交重试不会重复扣费，生成失败自动退款。文件保留 {limits?.retention_days || 7} 天。</p>
        {draft.submitted && jobs.find(j => j.id === draft.submitted)?.status === "error" && <Button variant="outline" onClick={() => patch({ submitted: undefined })}>保留方案，重新制作</Button>}
      </section>}
    </section><aside className="doc-side">
      <section className="doc-card"><div className="doc-section-title"><div><span>03</span><h2>任务与交付</h2></div></div><div className="doc-job-list">{jobs.filter(j => j.kind === kind).length ? jobs.filter(j => j.kind === kind).map(job => <button key={job.id} className={selected === job.id ? "selected" : ""} onClick={() => setSelected(job.id)}><strong>{job.title}</strong><span>{statusNames[job.status] || job.status} · {job.price} 积分</span></button>) : <p className="doc-help">还没有任务。确认左侧方案后，制作进度会出现在这里。</p>}</div></section>
      {active && <section className="doc-card doc-delivery"><h2>{active.title}</h2><p className="doc-help">{active.phase} · {Math.floor(active.elapsed_seconds / 60)} 分 {active.elapsed_seconds % 60} 秒</p>{active.error && <div className="doc-alert">{active.error}</div>}{["queued", "running"].includes(active.status) && <p className="doc-running"><LoaderCircle className="size-5 animate-spin" />任务在后台执行，关闭页面后仍会继续。</p>}{active.expired ? <div className="doc-notice">文件已超过保留期限，任务记录仍保留。</div> : active.result && <><div className="doc-downloads"><Button onClick={() => void download(active.result!.primary_url, active.kind === "ppt" ? "presentation.pptx" : "layers.psd")}><Download className="size-4" />下载 {active.kind.toUpperCase()}</Button><Button variant="outline" onClick={() => void download(active.result!.zip_url, "assets.zip")}>下载素材包</Button></div>{active.result.warnings.map((w, i) => <p className="doc-help" key={i}>{w}</p>)}{active.result.original_url && <details><summary>查看原图，核对拆分效果</summary><PrivateImage path={active.result.original_url} alt="PSD 原图" /></details>}{active.result.previews.map((url, i) => <figure key={url}><PrivateImage path={url} alt={active.kind === "ppt" ? "实际生成的第 " + (i + 1) + " 页" : "PSD 图层合成预览"} /><figcaption>{active.kind === "ppt" ? "第 " + (i + 1) + " 页 · 实际文件渲染" : "图层合成预览；请核对边缘与元素归属"}</figcaption></figure>)}</>}</section>}
      {legacy.length > 0 && <details className="doc-card"><summary>旧版账号任务历史（{legacy.length}）</summary>{legacy.slice(0, 30).map(job => <div className="doc-legacy" key={job.id || job.taskId}><span>{job.kind.toUpperCase()} · {job.created_at} · {statusNames[job.status] || job.status}</span>{job.result?.primary_url && <button onClick={() => void download(job.result!.primary_url!, job.kind === "ppt" ? "legacy.pptx" : "legacy.psd")}>下载文件</button>}{job.result?.zip_url && <button onClick={() => void download(job.result!.zip_url!, "legacy-assets.zip")}>素材包</button>}</div>)}</details>}
    </aside></div>
  </main>;
}
