"use client";

import { useEffect, useRef, useState } from "react";
import { ClipboardList, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchAdminAuditRecords, type AdminAuditRecord } from "@/lib/api";

const actionOptions = [
  ["all", "全部动作"],
  ["key.create", "创建兑换码"],
  ["key.update", "更新兑换码"],
  ["key.delete", "删除兑换码"],
  ["key.reset", "重置兑换码"],
  ["key.top_up", "兑换码加额"],
  ["user.create", "创建用户"],
  ["user.update", "更新用户"],
  ["user.delete", "删除用户"],
  ["user.quota", "调整用户积分"],
  ["user.api_key.delete", "删除用户 Key"],
  ["usage.clear", "清理用量"],
  ["image_cache.delete", "删除图片缓存"],
] as const;

function formatTime(timestamp: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN");
}

function formatAction(action: string) {
  return actionOptions.find(([value]) => value === action)?.[1] || action;
}

function formatDetail(detail: Record<string, unknown>) {
  const entries = Object.entries(detail || {});
  if (entries.length === 0) return "-";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("；");
}

export default function AdminAuditPage() {
  const didLoadRef = useRef(false);
  const [records, setRecords] = useState<AdminAuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState("all");
  const [targetQuery, setTargetQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("50");
  const [isLoading, setIsLoading] = useState(true);

  const currentPageSize = Number(pageSize) || 50;
  const pageCount = Math.max(1, Math.ceil(total / currentPageSize));
  const safePage = Math.min(page, pageCount);

  const loadRecords = async (silent = false, targetPage = page) => {
    if (!silent) setIsLoading(true);
    try {
      const data = await fetchAdminAuditRecords({
        action: action === "all" ? undefined : action,
        limit: currentPageSize,
        offset: Math.max(0, targetPage - 1) * currentPageSize,
      });
      setRecords(data.records);
      setTotal(data.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载审计日志失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadRecords();
  }, []);

  useEffect(() => {
    if (!didLoadRef.current) return;
    void loadRecords(true);
  }, [page, pageSize, action]);

  const visibleRecords = records.filter((item) => {
    const query = targetQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      item.target.toLowerCase().includes(query) ||
      item.admin.toLowerCase().includes(query) ||
      formatDetail(item.detail).toLowerCase().includes(query)
    );
  });

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Audit</div>
          <h1 className="text-2xl font-semibold tracking-tight">操作审计</h1>
          <p className="text-sm text-stone-500">追踪后台关键变更动作，便于排查误操作和异常变更。</p>
        </div>
        <Button variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4" onClick={() => void loadRecords()}>
          <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={targetQuery}
                onChange={(event) => setTargetQuery(event.target.value)}
                placeholder="搜索目标、管理员或详情"
                className="h-10 rounded-xl border-stone-200 bg-white pl-10"
              />
            </div>
            <Select
              value={action}
              onValueChange={(value) => {
                setAction(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white lg:w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {actionOptions.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={pageSize}
              onValueChange={(value) => {
                setPageSize(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white lg:w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20 条/页</SelectItem>
                <SelectItem value="50">50 条/页</SelectItem>
                <SelectItem value="100">100 条/页</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 py-12 text-sm text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />
              正在加载审计日志
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-stone-200 bg-stone-50 text-stone-500">
              <ClipboardList className="size-7" />
              <div className="text-sm">暂无符合条件的审计记录。</div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-stone-50 text-xs text-stone-500">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">时间</th>
                      <th className="px-3 py-2.5 font-medium">管理员</th>
                      <th className="px-3 py-2.5 font-medium">动作</th>
                      <th className="px-3 py-2.5 font-medium">目标</th>
                      <th className="px-3 py-2.5 font-medium">详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRecords.map((record) => (
                      <tr key={record.id} className="border-t border-stone-100 align-top">
                        <td className="px-3 py-2.5 whitespace-nowrap text-stone-600">{formatTime(record.timestamp)}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-stone-500">{record.admin || "-"}</td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline">{formatAction(record.action)}</Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="max-w-[260px] truncate font-mono text-xs text-stone-500">{record.target || "-"}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="max-w-[520px] break-words text-xs leading-5 text-stone-600">{formatDetail(record.detail)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col gap-3 border-t border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  第 {safePage} / {pageCount} 页，当前显示 {visibleRecords.length} 条，共 {total} 条
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
    </section>
  );
}
