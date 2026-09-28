"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  Ticket,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  fetchAdminAccountStats,
  fetchAdminGeneratedImages,
  fetchAdminSystemInfo,
  fetchAdminUsageRecords,
  fetchAdminUsageStats,
  fetchAdminUsers,
  type AdminAccountStats,
  type AdminSystemInfo,
  type UsageRecordItem,
  type UsageStats,
} from "@/lib/api";

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

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

function formatTime(timestamp?: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN");
}

export default function AdminDashboardPage() {
  const [system, setSystem] = useState<AdminSystemInfo | null>(null);
  const [accountStats, setAccountStats] = useState<AdminAccountStats | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [recentRecords, setRecentRecords] = useState<UsageRecordItem[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [cacheTotal, setCacheTotal] = useState(0);
  const [cacheSize, setCacheSize] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadDashboard = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const [systemData, accountData, usageData, recordsData, usersData, cacheData] = await Promise.all([
        fetchAdminSystemInfo(),
        fetchAdminAccountStats(),
        fetchAdminUsageStats({ days: 7 }),
        fetchAdminUsageRecords({ limit: 8 }),
        fetchAdminUsers({ limit: 1 }),
        fetchAdminGeneratedImages({ limit: 1 }),
      ]);
      setSystem(systemData);
      setAccountStats(accountData);
      setUsageStats(usageData);
      setRecentRecords(recordsData.records);
      setUserTotal(usersData.total);
      setCacheTotal(cacheData.total);
      setCacheSize(cacheData.total_size_bytes);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载后台总览失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  const successRate = useMemo(() => {
    if (!usageStats?.total) return "0%";
    return `${Math.round((usageStats.success / usageStats.total) * 100)}%`;
  }, [usageStats]);

  const healthItems = [
    {
      label: "正常账号",
      value: accountStats?.active ?? 0,
      icon: CheckCircle2,
      color: "text-emerald-600",
      href: "/admin/accounts",
    },
    {
      label: "限流账号",
      value: accountStats?.limited ?? 0,
      icon: AlertTriangle,
      color: "text-amber-600",
      href: "/admin/accounts",
    },
    {
      label: "异常账号",
      value: accountStats?.error ?? 0,
      icon: AlertTriangle,
      color: "text-rose-600",
      href: "/admin/accounts",
    },
    {
      label: "缓存图片",
      value: cacheTotal,
      icon: HardDrive,
      color: "text-sky-600",
      href: "/admin/cache",
    },
  ];

  if (isLoading) {
    return (
      <div className="flex min-h-[45vh] items-center justify-center text-stone-500">
        <LoaderCircle className="mr-2 size-5 animate-spin" />
        正在加载后台总览
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Dashboard</div>
          <h1 className="text-2xl font-semibold tracking-tight">后台总览</h1>
          <p className="text-sm text-stone-500">集中查看账号池、用户、兑换码、用量和缓存状态。</p>
        </div>
        <Button variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4" onClick={() => void loadDashboard()}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "账号总数", value: accountStats?.total ?? 0, icon: Database, href: "/admin/accounts" },
          { label: "前台用户", value: userTotal, icon: Users, href: "/admin/users" },
          { label: "兑换码", value: system?.keys_total ?? 0, icon: Ticket, href: "/admin/keys" },
          { label: "7 日请求", value: usageStats?.total ?? 0, icon: Activity, href: "/admin/keys" },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.label} href={item.href}>
              <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm transition hover:border-stone-200 hover:bg-white">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center justify-between text-stone-400">
                    <span className="text-xs font-medium">{item.label}</span>
                    <Icon className="size-4" />
                  </div>
                  <div className="text-3xl font-semibold tracking-tight text-stone-900">{item.value}</div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.7fr)]">
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-5 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">系统健康</h2>
                <p className="text-sm text-stone-500">账号池和缓存的关键状态。</p>
              </div>
              <Badge variant={(accountStats?.error ?? 0) > 0 ? "warning" : "success"}>
                {(accountStats?.error ?? 0) > 0 ? "需要处理" : "运行正常"}
              </Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {healthItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.label} href={item.href} className="rounded-xl border border-stone-200 bg-white p-4 transition hover:bg-stone-50">
                    <div className="flex items-center justify-between text-sm text-stone-500">
                      <span>{item.label}</span>
                      <Icon className={`size-4 ${item.color}`} />
                    </div>
                    <div className={`mt-3 text-3xl font-semibold tracking-tight ${item.color}`}>{item.value}</div>
                  </Link>
                );
              })}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl bg-stone-50 p-4">
                <div className="text-xs text-stone-400">7 日成功率</div>
                <div className="mt-2 text-2xl font-semibold text-emerald-600">{successRate}</div>
              </div>
              <div className="rounded-xl bg-stone-50 p-4">
                <div className="text-xs text-stone-400">平均耗时</div>
                <div className="mt-2 text-2xl font-semibold text-stone-900">{usageStats?.avg_duration_ms ?? 0}ms</div>
              </div>
              <div className="rounded-xl bg-stone-50 p-4">
                <div className="text-xs text-stone-400">缓存占用</div>
                <div className="mt-2 text-2xl font-semibold text-stone-900">{formatBytes(cacheSize)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-5 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">系统信息</h2>
                <p className="text-sm text-stone-500">当前实例和密钥概况。</p>
              </div>
              <ServerCog className="size-5 text-stone-400" />
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between rounded-xl bg-stone-50 px-4 py-3">
                <span className="text-stone-500">版本</span>
                <span className="font-medium text-stone-900">{system?.version || "-"}</span>
              </div>
              <div className="flex justify-between rounded-xl bg-stone-50 px-4 py-3">
                <span className="text-stone-500">启用兑换码</span>
                <span className="font-medium text-stone-900">{system?.keys_enabled ?? 0}</span>
              </div>
              <div className="flex justify-between rounded-xl bg-stone-50 px-4 py-3">
                <span className="text-stone-500">管理员密钥</span>
                <span className="font-medium text-stone-900">{system?.admin_keys ?? 0}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="rounded-xl border-stone-200 bg-white" asChild>
                <Link href="/admin/settings">
                  <ServerCog className="size-4" />
                  设置
                </Link>
              </Button>
              <Button variant="outline" className="rounded-xl border-stone-200 bg-white" asChild>
                <Link href="/admin/keys">
                  <KeyRound className="size-4" />
                  兑换码
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">最近调用</h2>
              <p className="text-sm text-stone-500">最近 8 条图片相关请求。</p>
            </div>
            <Button variant="outline" className="rounded-xl border-stone-200 bg-white" asChild>
              <Link href="/admin/keys">查看用量</Link>
            </Button>
          </div>
          {recentRecords.length === 0 ? (
            <div className="py-8 text-sm text-stone-500">暂无调用记录。</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-stone-50 text-xs text-stone-500">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">状态</th>
                      <th className="px-3 py-2.5 font-medium">类型</th>
                      <th className="px-3 py-2.5 font-medium">密钥</th>
                      <th className="px-3 py-2.5 font-medium">模型</th>
                      <th className="px-3 py-2.5 font-medium">耗时</th>
                      <th className="px-3 py-2.5 font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRecords.map((record) => (
                      <tr key={record.id} className="border-t border-stone-100">
                        <td className="px-3 py-2.5">
                          <Badge variant={record.status === "success" ? "success" : "danger"}>
                            {record.status === "success" ? "成功" : "失败"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">{formatAction(record.action)}</td>
                        <td className="px-3 py-2.5">{record.api_key_name || record.api_key || "-"}</td>
                        <td className="px-3 py-2.5">{record.model || "-"}</td>
                        <td className="px-3 py-2.5">{record.duration_ms}ms</td>
                        <td className="px-3 py-2.5">{record.timestamp_str || formatTime(record.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
