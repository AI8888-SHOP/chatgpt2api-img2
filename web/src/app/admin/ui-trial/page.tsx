"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { httpRequest } from "@/lib/request";

type TrialStats = {
  trial_id: string; days: number; participants: number; active_users: number; tried_both: number;
  votes: { a: number; b: number; equal: number }; not_voted: number; started_at: number | null;
  variants: { variant: "a" | "b"; assigned: number; experienced: number; current: number; active_current: number; preferred: number; preferred_by_cohort: { a: number; b: number } }[];
};

export default function UiTrialPage() {
  const [stats, setStats] = useState<TrialStats | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const load = async () => {
    setBusy(true); setError("");
    try { setStats(await httpRequest<TrialStats>("/api/ui-trial/stats?days=7")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "加载试用统计失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const votes = stats ? stats.votes.a + stats.votes.b + stats.votes.equal : 0;
  return <section className="trial-dashboard">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">界面试用</h1><p className="mt-2 text-sm text-muted-foreground">A 雾白靛蓝 / B 石墨青绿 · 自主切换，不自动淘汰任何方案</p></div><button type="button" className="studio-text-button" disabled={busy} onClick={() => void load()}><RefreshCw size={16} className={busy ? "animate-spin" : ""} />刷新统计</button></header>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {busy && !stats && <p role="status">正在读取试用数据…</p>}
    {stats && <>
      <div className="trial-metrics">{[{ label: "参与账号", value: stats.participants }, { label: "近 7 天体验过", value: stats.active_users }, { label: "两款都已体验", value: stats.tried_both }, { label: "已提交偏好", value: votes }].map(item => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>)}</div>
      {!stats.participants && <p className="trial-empty">试用已就绪，用户登录前台后开始记录。当前还没有体验数据。</p>}
      <div className="trial-comparison">{stats.variants.map(item => <article key={item.variant}><header><span className={"design-dot design-dot-" + item.variant} /><h2>{item.variant === "a" ? "A · 雾白靛蓝" : "B · 石墨青绿"}</h2><span>{item.variant === "a" ? "对话式" : "画布式"}</span></header><dl>{[{ label: "初始分组人数", value: item.assigned }, { label: "累计体验人数", value: item.experienced }, { label: "当前选用人数", value: item.current }, { label: "近 7 天活跃且当前选用", value: item.active_current }, { label: "明确偏好票数", value: item.preferred }].map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl><div className="trial-vote-share"><span>占全部有效投票（含“都可以”）</span><strong>{votes ? (item.preferred / votes * 100).toFixed(1) + "%" : "—"}</strong></div></article>)}</div>
      <p className="text-sm text-muted-foreground">都可以：{stats.votes.equal} 票 · 尚未投票：{stats.not_voted} 人。切换次数与默认分组不计作偏好票；同一账号修改投票会覆盖旧票，撤回后不计票。</p>
      <div className="trial-cohorts"><h2 className="text-base font-medium">按初始分组检查偏好</h2><div className="overflow-x-auto"><table><thead><tr><th>初始分组</th><th>更喜欢 A</th><th>更喜欢 B</th></tr></thead><tbody>{["a", "b"].map(cohort => <tr key={cohort}><th>初始 {cohort.toUpperCase()}</th>{stats.variants.map(item => <td key={item.variant}>{item.preferred_by_cohort[cohort as "a" | "b"]}</td>)}</tr>)}</tbody></table></div></div>
      <div className="trial-method"><h2 className="text-base font-medium">统计口径</h2><p>按账号稳定哈希近似均分 A/B，同一账号跨设备保留选择。每个账号仅记录一份试用状态，先体验两款才能投票。不额外保存提示词、图片或逐次点击日志。</p><p>“累计体验”可同时包含同一用户，因此 A/B 相加可能超过参与人数。除标注“近 7 天”的指标外，其余均为本次试用累计数；偏好票为每人最近一次有效选择。</p><p>这是自愿反馈，不是严格随机对照实验。先观察实际样本与分组偏差，再决定保留哪款；样本不足时不宣布胜出。</p><p>首次体验：{stats.started_at ? new Date(stats.started_at * 1000).toLocaleString("zh-CN") : "尚无"} · 试用标识：{stats.trial_id}</p></div>
    </>}
  </section>;
}
