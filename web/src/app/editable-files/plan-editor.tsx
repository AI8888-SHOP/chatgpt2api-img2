"use client";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState } from "react";
import type { StudioPlan } from "@/lib/editable-studio";

export function PlanEditor({ plan, change, image, disabled }: { plan: StudioPlan; change: (plan: StudioPlan) => void; image?: string; disabled: boolean }) {
  const [activeLayer, setActiveLayer] = useState<number | null>(null);
  return <fieldset disabled={disabled} className="doc-plan-fields">
    <label className="doc-label">文件标题<input aria-label="文件标题" maxLength={100} value={plan.title} onChange={e => change({ ...plan, title: e.target.value })} /></label>
    <p className="doc-help">{plan.summary}</p>
    {plan.warnings.length > 0 && <div className="doc-warnings">{plan.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
    {plan.kind === "ppt" ? plan.slides.map((slide, i) => <article className="doc-plan-item" key={i}>
      <header><strong>第 {i + 1} 页</strong><div>
        <button aria-label={"上移第 " + (i + 1) + " 页"} disabled={!i} onClick={() => { const next = [...plan.slides]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; change({ ...plan, slides: next }); }}><ArrowUp size={15} /></button>
        <button aria-label={"下移第 " + (i + 1) + " 页"} disabled={i === plan.slides.length - 1} onClick={() => { const next = [...plan.slides]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; change({ ...plan, slides: next }); }}><ArrowDown size={15} /></button>
        <button aria-label={"删除第 " + (i + 1) + " 页"} disabled={plan.slides.length < 2} onClick={() => change({ ...plan, slides: plan.slides.filter((_, n) => i !== n) })}><Trash2 size={15} /></button>
      </div></header>
      <input aria-label={"第 " + (i + 1) + " 页标题"} maxLength={80} value={slide.title} onChange={e => change({ ...plan, slides: plan.slides.map((s, n) => n === i ? { ...s, title: e.target.value } : s) })} />
      <textarea aria-label={"第 " + (i + 1) + " 页内容"} value={slide.body.join("\n")} onChange={e => change({ ...plan, slides: plan.slides.map((s, n) => n === i ? { ...s, body: e.target.value.split("\n").slice(0, 5) } : s) })} />
      <small>一行一个要点，最多 5 条。没有提供的数据请保留“待补充”。</small>
    </article>) : <>
      {image && <div className="doc-layer-map"><img src={image} alt="原图与预计图层范围" /><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">{plan.layers.map((l, i) => <rect key={i} x={l.box[0]} y={l.box[1]} width={l.box[2]} height={l.box[3]} fill={activeLayer === i ? "#6366f133" : "none"} stroke={activeLayer === i ? "#f59e0b" : "#4f46e5"} strokeWidth={4} />)}</svg></div>}
      {plan.layers.map((layer, i) => <article className="doc-plan-item" key={i} onFocus={() => setActiveLayer(i)} onMouseEnter={() => setActiveLayer(i)}>
        <header><strong>图层 {i + 1} · {layer.kind === "text" ? "像素文字" : "独立元素"}</strong><button aria-label={"删除图层 " + (i + 1)} disabled={plan.layers.length < 2} onClick={() => change({ ...plan, layers: plan.layers.filter((_, n) => n !== i) })}><Trash2 size={15} /></button></header>
        <input aria-label={"图层 " + (i + 1) + " 名称"} maxLength={60} value={layer.name} onChange={e => change({ ...plan, layers: plan.layers.map((l, n) => n === i ? { ...l, name: e.target.value } : l) })} />
        <div className="doc-box-fields">{["左", "上", "宽", "高"].map((label, coordinate) => <label key={label}>{label}<input aria-label={"图层 " + (i + 1) + " " + label} type="number" min={coordinate < 2 ? 0 : 1} max={1000} value={layer.box[coordinate]} onChange={e => change({ ...plan, layers: plan.layers.map((l, n) => n === i ? { ...l, polygon: [], box: l.box.map((v, p) => p === coordinate ? Number(e.target.value) : v) } : l) })} /></label>)}</div>
      </article>)}<small>坐标按 0–1000 表示。背景自动生成，不需单独添加。</small>
    </>}
  </fieldset>;
}
