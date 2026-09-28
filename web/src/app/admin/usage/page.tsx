"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  clearAdminUsageRecords,
  fetchAdminUsageRecords,
  fetchAdminUsageStats,
  type UsageRecordItem,
  type UsageStats,
} from "@/lib/api";

function formatAction(action: string) {
  return (
    {
      image_generate: "文生图",
      image_edit: "编辑图",
      chat_image_completion: "Chat 兼容",
      responses_image_generation: "Responses 兼容",
    }[action] || action || "未标记"
  );
}

function formatTime(timestamp: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN");
}

export default function AdminUsagePage() {
  const didLoadRef = useRef(false);
  const [records, setRecords] = useState<UsageRecordItem[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [total, setTotal] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [days, setDays] = useState("7");
  const [pageSize, setPageSize] = useState("50");
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);

  const offset = (page - 1) * Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(total / Number(pageSize)));

  const loadUsage = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const normalizedKey = apiKey.trim();
      const [statsData, recordsData] = await Promise.all([
        fetchAdminUsageStats({
          api_key: normalizedKey || undefined,
          days: Number(days) || 7,
        }),
        fetchAdminUsageRecords({
          api_key: normalizedKey || undefined,
          limit: Number(pageSize) || 50,
          offset,
        }),
      ]);
      setStats(statsData);
      setRecords(recordsData.records);
      setTotal(recordsData.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用量记录失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadUsage();
  }, []);

  useEffect(() => {
    if (!didLoadRef.current) return;
    void loadUsage(true);
  }, [page, pageSize, days]);

  const successRate = useMemo(() => {
    if (!stats?.total) return "0%";
    return `${Math.round((stats.success / stats.total) * 100)}%`;
  }, [stats]);

  const errorSummary = useMemo(() => {
    const counts = new Map<string, number>();
    records
      .filter((record) => record.status !== "success" && record.error)
      .forEach((record) => counts.set(record.error, (counts.get(record.error) || 0) + 1));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [records]);

  const handleSearch = () => {
    setPage(1);
    void loadUsage();
  };

  const handleClear = async () => {
    const keepDays = Math.max(1, Number(days) || 7);
    const confirmed = window.confirm(`确认清理 ${keepDays} 天前的用量记录？`);
    if (!confirmed) return;
    setIsClearing(true);
    try {
      const result = await clearAdminUsageRecords(keepDays);
      toast.success(result.message || "已清理旧记录");
      setPage(1);
      await loadUsage(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理用量记录失败");
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Usage</div>
          <h1 className="text-2xl font-semibold tracking-tight">用量记录</h1>
          <p className="text-sm text-stone-500">查看请求、成功率、失败原因和历史调用明细。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4" onClick={() => void loadUsage()}>
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
            刷新
          </Button>
          <Button
            variant="destructive"
            className="h-10 rounded-xl px-4"
            onClick={() => void handleClear()}
            disabled={isClearing}
          >
            {isClearing ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            清理旧记录
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "总请求", value: stats?.total ?? 0, icon: Activity, color: "text-stone-900" },
          { label: "成功", value: stats?.success ?? 0, icon: CheckCircle2, color: "text-emerald-600" },
          { label: "失败", value: stats?.failed ?? 0, icon: XCircle, color: "text-rose-600" },
          { label: "平均耗时", value: `${stats?.avg_duration_ms ?? 0}ms`, icon: Clock, color: "text-sky-600" },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.label} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center justify-between text-stone-400">
                  <span className="text-xs font-medium">{item.label}</span>
                  <Icon className="size-4" />
                </div>
                <div className={`text-3xl font-semibold tracking-tight ${item.color}`}>{item.value}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.42fr)]">
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">调用明细</h2>
                <p className="text-sm text-stone-500">当前筛选成功率 {successRate}。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-[260px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") handleSearch();
                    }}
                    placeholder="按用户 ID / 密钥筛选"
                    className="h-10 rounded-xl border-stone-200 bg-white pl-10"
                  />
                </div>
                <Select value={days} onValueChange={(value) => { setDays(value); setPage(1); }}>
                  <SelectTrigger className="h-10 w-[120px] rounded-xl border-stone-200 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 天</SelectItem>
                    <SelectItem value="7">7 天</SelectItem>
                    <SelectItem value="30">30 天</SelectItem>
                    <SelectItem value="90">90 天</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={pageSize} onValueChange={(value) => { setPageSize(value); setPage(1); }}>
                  <SelectTrigger className="h-10 w-[118px] rounded-xl border-stone-200 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20">20 条/页</SelectItem>
                    <SelectItem value="50">50 条/页</SelectItem>
                    <SelectItem value="100">100 条/页</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4" onClick={handleSearch}>
                  搜索
                </Button>
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 py-12 text-sm text-stone-500">
                <LoaderCircle className="size-4 animate-spin" />
                正在加载用量记录
              </div>
            ) : records.length === 0 ? (
              <div className="py-12 text-sm text-stone-500">暂无用量记录。</div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-stone-50 text-xs text-stone-500">
                      <tr>
                        <th className="px-3 py-2.5 font-medium">状态</th>
                        <th className="px-3 py-2.5 font-medium">类型</th>
                        <th className="px-3 py-2.5 font-medium">密钥</th>
                        <th className="px-3 py-2.5 font-medium">提示词</th>
                        <th className="px-3 py-2.5 font-medium">模型</th>
                        <th className="px-3 py-2.5 font-medium">耗时</th>
                        <th className="px-3 py-2.5 font-medium">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((record) => (
                        <tr key={record.id} className="border-t border-stone-100 align-top">
                          <td className="px-3 py-2.5">
                            <Badge variant={record.status === "success" ? "success" : "danger"}>
                              {record.status === "success" ? "成功" : "失败"}
                            </Badge>
                          </td>
                          <td className="px-3 py-2.5">{formatAction(record.action)}</td>
                          <td className="px-3 py-2.5">
                            <div className="max-w-[190px] truncate">{record.api_key_name || record.api_key || "-"}</div>
                            <div className="max-w-[190px] truncate font-mono text-[11px] text-stone-400">{record.api_key}</div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="max-w-[360px] line-clamp-2 text-stone-600">{record.prompt || "-"}</div>
                            {record.error ? <div className="mt-1 max-w-[360px] line-clamp-2 text-xs text-rose-500">{record.error}</div> : null}
                          </td>
                          <td className="px-3 py-2.5">{record.model || "-"}</td>
                          <td className="px-3 py-2.5">{record.duration_ms}ms</td>
                          <td className="px-3 py-2.5">{record.timestamp_str || formatTime(record.timestamp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col gap-3 border-t border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    第 {page} / {pageCount} 页，共 {total} 条
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs"
                      disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      variant="outline"
                      className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs"
                      disabled={page >= pageCount}
                      onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-5 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">失败摘要</h2>
                <p className="text-sm text-stone-500">当前页失败原因聚合。</p>
              </div>
              <AlertTriangle className="size-5 text-amber-500" />
            </div>
            {errorSummary.length === 0 ? (
              <div className="rounded-xl bg-stone-50 p-4 text-sm text-stone-500">当前页没有失败记录。</div>
            ) : (
              <div className="space-y-3">
                {errorSummary.map(([error, count]) => (
                  <div key={error} className="rounded-xl border border-stone-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant="danger">{count} 次</Badge>
                    </div>
                    <div className="mt-2 line-clamp-4 text-sm leading-6 text-stone-600">{error}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
