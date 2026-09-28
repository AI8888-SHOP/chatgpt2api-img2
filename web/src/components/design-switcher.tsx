"use client";

import { useState } from "react";
import { Check, Palette } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useDesign, type DesignPreference } from "@/components/design-provider";

export function DesignSwitcher({ user = true }: { user?: boolean }) {
  const { variant, trial, busy, error, choose, vote, retry } = useDesign();
  const [open, setOpen] = useState(false);
  return <div className="design-switcher">
    <div className="design-segment" role="group" aria-label="切换界面方案">
      <button type="button" aria-label="切换到 A 雾白靛蓝" aria-pressed={variant === "a"} disabled={busy} onClick={() => void choose("a")}><span className="design-dot design-dot-a" />A<span className="design-label"> 雾白靛蓝</span></button>
      <button type="button" aria-label="切换到 B 石墨青绿" aria-pressed={variant === "b"} disabled={busy} onClick={() => void choose("b")}><span className="design-dot design-dot-b" />B<span className="design-label"> 石墨青绿</span></button>
    </div>
    {user && <button type="button" className="studio-icon-button design-feedback" aria-label="界面试用与偏好投票" onClick={() => setOpen(true)}><Palette size={17} /><span>投票</span>{error && <span className="design-error-dot" aria-label="偏好同步失败" />}</button>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="design-vote-dialog sm:max-w-lg">
        <DialogHeader><DialogTitle>这两款界面，你更喜欢哪款？</DialogTitle><DialogDescription>两套功能、积分和生成能力完全一致。可随时切换，输入和当前对话不会丢失。</DialogDescription></DialogHeader>
        <div className="design-options">
          <button type="button" disabled={busy} aria-pressed={variant === "a"} onClick={() => void choose("a")}><span className="design-dot design-dot-a" /><strong>A · 雾白靛蓝</strong><span>对话式 · 输入框在结果下方</span><small>{trial?.seen_a ? "已体验" : "试试这款"}</small></button>
          <button type="button" disabled={busy} aria-pressed={variant === "b"} onClick={() => void choose("b")}><span className="design-dot design-dot-b" /><strong>B · 石墨青绿</strong><span>画布式 · 右侧独立创作面板</span><small>{trial?.seen_b ? "已体验" : "试试这款"}</small></button>
        </div>
        <p className="text-sm text-muted-foreground">{trial?.seen_a && trial?.seen_b ? "两款都体验过了，可以提交偏好。每个账号只计一票，可修改或撤回。" : "先分别体验 A、B，再告诉我们你的偏好。切换界面不等于投票。"}</p>
        <div className="design-votes">{([{ value: "a", label: "更喜欢 A" }, { value: "b", label: "更喜欢 B" }, { value: "equal", label: "都可以" }] as { value: DesignPreference; label: string }[]).map(option => <button type="button" key={option.value} aria-pressed={trial?.preference === option.value} disabled={busy || !trial?.seen_a || !trial?.seen_b} onClick={() => void vote(option.value)}>{trial?.preference === option.value && <Check size={14} />}{option.label}</button>)}</div>
        {trial?.preference && <div className="flex items-center justify-between gap-3 text-sm"><span role="status">偏好已保存</span><button type="button" className="studio-text-button" disabled={busy} onClick={() => void vote(null)}>撤回投票</button></div>}
        {error && <div role="alert" className="text-sm text-destructive">{error} <button type="button" disabled={busy} onClick={retry} className="underline">重试同步</button></div>}
        <p className="text-xs text-muted-foreground">试用仅记录账号的界面选择、体验时间和偏好，不额外采集提示词或图片。投票不消耗积分。</p>
      </DialogContent>
    </Dialog>
  </div>;
}
