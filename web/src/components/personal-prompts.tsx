"use client";

import { useRef, useState } from "react";
import { BookmarkPlus, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchPersonalPrompts, savePersonalPrompt, deletePersonalPrompt, type PersonalPrompt } from "@/lib/api";

export function PersonalPrompts({ prompt, onApply }: { prompt: string; onApply: (content: string) => void }) {
  const [items, setItems] = useState<PersonalPrompt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ id?: string; label: string; content: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const mutation = useRef(false);
  const load = async () => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try { const data = await fetchPersonalPrompts(); setItems(data.items); setLoaded(true); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
    finally { mutation.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!editor || mutation.current) return;
    mutation.current = true; setBusy(true); setError("");
    try {
      const saved = await savePersonalPrompt({ label: editor.label.trim(), content: editor.content.trim() }, editor.id);
      setItems(current => editor.id ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]);
      setEditor(null); toast.success("个人预设已保存到服务器");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { mutation.current = false; setBusy(false); }
  };
  const remove = async (id: string) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError("");
    try { await deletePersonalPrompt(id); setItems(current => current.filter(item => item.id !== id)); setDeleting(null); if (editor?.id === id) setEditor(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
    finally { mutation.current = false; setBusy(false); }
  };
  return <details className="my-2 rounded-lg border bg-card text-sm" onToggle={event => { if (event.currentTarget.open) void load(); }} data-testid="personal-prompts">
    <summary className="cursor-pointer px-3 py-2">我的预设提示词{loaded ? ` · ${items.length}/15` : ""}</summary>
    <div className="space-y-3 border-t p-3">
      <p className="text-xs text-muted-foreground">仅当前账号可见，保存在服务器，图片和视频均可使用。</p>
      {error && <p role="alert" className="text-xs text-red-600">{error}<button type="button" className="ml-2 underline" disabled={busy} onClick={() => void load()}>重新加载</button></p>}
      {busy && <p role="status" className="text-xs text-muted-foreground">正在同步…</p>}
      <div className="max-h-60 space-y-1 overflow-y-auto">
        {items.map(item => <div key={item.id} className="rounded-md border p-2">
          <div className="flex items-center gap-2"><button type="button" title={item.content} className="min-w-0 flex-1 truncate text-left hover:text-primary" onClick={() => onApply(item.content)}>{item.label}</button><button type="button" disabled={busy} aria-label={`编辑预设 ${item.label}`} onClick={() => { setEditor(item); setDeleting(null); }} className="p-1"><Pencil size={14} /></button><button type="button" disabled={busy} aria-label={`删除预设 ${item.label}`} onClick={() => setDeleting(item.id)} className="p-1"><Trash2 size={14} /></button></div>
          {deleting === item.id && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span>删除这条预设？</span><button type="button" disabled={busy} onClick={() => void remove(item.id)} className="text-red-600 underline">确认删除预设</button><button type="button" onClick={() => setDeleting(null)}>取消</button></div>}
        </div>)}
        {loaded && !items.length && <p className="text-xs text-muted-foreground">还没有个人预设，保存常用的风格或要求，下次一键填入。</p>}
      </div>
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={!loaded || busy || items.length >= 15} onClick={() => setEditor({ label: "", content: "" })}><Plus size={14} />新建预设</Button><Button type="button" size="sm" variant="outline" disabled={!loaded || busy || items.length >= 15 || !prompt.trim()} onClick={() => setEditor({ label: "", content: prompt.slice(0,8000) })}><BookmarkPlus size={14} />保存当前提示词</Button></div>
      {editor && <div className="space-y-2 rounded-md border p-3"><Input aria-label="个人预设名称" maxLength={60} value={editor.label} disabled={busy} placeholder="名称，例如：产品摄影" onChange={e => setEditor({ ...editor, label: e.target.value })} /><Textarea aria-label="个人预设内容" maxLength={8000} value={editor.content} disabled={busy} placeholder="输入需要重复使用的提示词" onChange={e => setEditor({ ...editor, content: e.target.value })} /><div className="flex gap-2"><Button type="button" size="sm" disabled={busy || !editor.label.trim() || !editor.content.trim()} onClick={() => void save()}><Check size={14} />保存个人预设</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditor(null)}>取消编辑</Button></div></div>}
      {items.length >= 15 && <p className="text-xs text-muted-foreground">已达到 15 条上限，可编辑或删除现有预设。</p>}
    </div>
  </details>;
}
