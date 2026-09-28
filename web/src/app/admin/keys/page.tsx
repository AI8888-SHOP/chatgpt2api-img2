"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Ticket,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  addAdminKeyUsage,
  createAdminKey,
  deleteAdminKey,
  fetchAdminKeys,
  resetAdminKeyUsage,
  updateAdminKey,
  type ApiKeySummary,
} from "@/lib/api";

type PackageTemplate = {
  id: string;
  label: string;
  maxUsage: string;
  expiresDays: string;
};

const packageTemplates: PackageTemplate[] = [
  { id: "trial", label: "试用版 20 点 / 3 天", maxUsage: "20", expiresDays: "3" },
  { id: "starter", label: "入门版 200 点 / 30 天", maxUsage: "200", expiresDays: "30" },
  { id: "pro", label: "专业版 1000 点 / 90 天", maxUsage: "1000", expiresDays: "90" },
  { id: "agency", label: "代理版 5000 点 / 365 天", maxUsage: "5000", expiresDays: "365" },
  { id: "custom", label: "自定义", maxUsage: "100", expiresDays: "30" },
];

function formatRemaining(item: ApiKeySummary) {
  return item.redeemed_at ? "已兑换" : "未兑换";
}

function formatCreditAmount(item: ApiKeySummary) {
  return String(Math.max(0, Number(item.credit_amount || item.max_usage || 0)));
}

function formatExpires(item: ApiKeySummary) {
  if (!item.expires_at) {
    return "永不过期";
  }
  return item.expires_at_str || new Date(item.expires_at * 1000).toLocaleString("zh-CN");
}

export default function AdminKeysPage() {
  const didLoadRef = useRef(false);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const [fullKeys, setFullKeys] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState("starter");
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [channel, setChannel] = useState("");
  const [packageName, setPackageName] = useState("入门版");
  const [batchCode, setBatchCode] = useState("");
  const [maxUsage, setMaxUsage] = useState("200");
  const [expiresDays, setExpiresDays] = useState("30");
  const [bulkCount, setBulkCount] = useState("1");
  const [bulkPrefix, setBulkPrefix] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [topUpValue, setTopUpValue] = useState("10");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("50");

  const applyTemplate = (nextTemplateId: string) => {
    setTemplateId(nextTemplateId);
    const template = packageTemplates.find((item) => item.id === nextTemplateId);
    if (!template) {
      return;
    }
    setMaxUsage(template.maxUsage);
    setExpiresDays(template.expiresDays);
    setPackageName(template.label.split(" ")[0] || template.label);
  };

  const loadKeys = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const keysData = await fetchAdminKeys();
      setKeys(keysData.keys);
      setSelectedKeys((prev) => prev.filter((key) => keysData.keys.some((item) => item.key === key)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载兑换码失败";
      toast.error(message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadKeys();
  }, []);

  const filteredKeys = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return keys.filter((item) => !item.is_admin).filter((item) => {
      const matchesQuery =
        !normalizedQuery ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.customer_name.toLowerCase().includes(normalizedQuery) ||
        item.channel.toLowerCase().includes(normalizedQuery) ||
        item.package_name.toLowerCase().includes(normalizedQuery) ||
        item.batch_code.toLowerCase().includes(normalizedQuery) ||
        String(item.redeemed_by || "").toLowerCase().includes(normalizedQuery) ||
        item.key.toLowerCase().includes(normalizedQuery);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "available"
          ? item.enabled && !item.redeemed_at && Boolean(item.is_valid)
          : statusFilter === "redeemed"
            ? Boolean(item.redeemed_at)
            : statusFilter === "disabled"
              ? !item.enabled
              : statusFilter === "invalid"
                ? !item.redeemed_at && !Boolean(item.is_valid)
                : true);
      return matchesQuery && matchesStatus;
    });
  }, [keys, searchQuery, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredKeys.length / Number(pageSize || 50)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize || 50);
  const pagedKeys = filteredKeys.slice(startIndex, startIndex + Number(pageSize || 50));
  const allCurrentSelected = pagedKeys.length > 0 && pagedKeys.every((item) => selectedKeys.includes(item.key));

  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, pageSize]);

  const summary = useMemo(() => {
    const redemptionCodes = keys.filter((item) => !item.is_admin);
    const total = redemptionCodes.length;
    const available = redemptionCodes.filter((item) => item.enabled && !item.redeemed_at && item.is_valid).length;
    const redeemed = redemptionCodes.filter((item) => item.redeemed_at).length;
    const disabled = redemptionCodes.filter((item) => !item.enabled).length;
    const creditTotal = redemptionCodes.reduce((sum, item) => sum + Number(formatCreditAmount(item)), 0);
    return { total, available, redeemed, disabled, creditTotal };
  }, [keys]);

  const packageStats = useMemo(() => {
    const stats = new Map<string, { total: number; redeemed: number; credit: number }>();
    keys.filter((item) => !item.is_admin).forEach((item) => {
      const name = item.package_name || "未设置套餐";
      const current = stats.get(name) || { total: 0, redeemed: 0, credit: 0 };
      current.total += 1;
      current.redeemed += item.redeemed_at ? 1 : 0;
      current.credit += Number(formatCreditAmount(item));
      stats.set(name, current);
    });
    return Array.from(stats.entries()).map(([name, value]) => ({ name, ...value })).sort((a, b) => b.total - a.total).slice(0, 8);
  }, [keys]);

  const batchStats = useMemo(() => {
    const stats = new Map<string, number>();
    keys.filter((item) => !item.is_admin).forEach((item) => {
      const name = item.batch_code || "未设置批次";
      stats.set(name, (stats.get(name) || 0) + 1);
    });
    return Array.from(stats.entries()).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total).slice(0, 8);
  }, [keys]);

  const handleCreateKeys = async () => {
    const count = Math.max(1, Math.min(50, Number(bulkCount) || 1));
    setIsSubmitting(true);
    try {
      const createdKeys: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const currentName =
          count === 1
            ? name.trim()
            : `${bulkPrefix.trim() || name.trim() || "批量兑换码"}-${String(index + 1).padStart(3, "0")}`;
        const data = await createAdminKey({
          name: currentName,
          customer_name: customerName.trim(),
          channel: channel.trim(),
          package_name: packageName.trim(),
          batch_code: batchCode.trim() || bulkPrefix.trim(),
          max_usage: Number(maxUsage || -1),
          expires_days: Number(expiresDays || 0),
          is_admin: false,
        });
        createdKeys.push(data.key);
      }
      setFullKeys(createdKeys);
      setName("");
      setCustomerName("");
      setChannel("");
      setBulkPrefix("");
      setBulkCount("1");
      applyTemplate(templateId);
      await loadKeys(true);
      toast.success(count === 1 ? "兑换码已生成" : `已批量生成 ${count} 个兑换码`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成兑换码失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleEnabled = async (item: ApiKeySummary) => {
    try {
      await updateAdminKey(item.key, { enabled: !item.enabled });
      await loadKeys(true);
      toast.success(item.enabled ? "兑换码已停用" : "兑换码已启用");
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新兑换码状态失败";
      toast.error(message);
    }
  };

  const handleReset = async (key: string) => {
    const confirmed = window.confirm("确认重置该兑换码的兑换状态？重置后可能允许再次兑换。");
    if (!confirmed) {
      return;
    }
    try {
      await resetAdminKeyUsage(key);
      await loadKeys(true);
      toast.success("兑换状态已重置");
    } catch (error) {
      const message = error instanceof Error ? error.message : "重置失败";
      toast.error(message);
    }
  };

  const handleTopUp = async (key: string) => {
    const amount = Math.max(1, Number(topUpValue) || 1);
    try {
      await addAdminKeyUsage(key, amount);
      await loadKeys(true);
      toast.success(`已加额 ${amount} 次`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加额失败";
      toast.error(message);
    }
  };

  const handleDelete = async (key: string) => {
    const confirmed = window.confirm("确认删除该兑换码？删除后无法通过后台恢复。");
    if (!confirmed) {
      return;
    }
    try {
      await deleteAdminKey(key);
      await loadKeys(true);
      setSelectedKeys((prev) => prev.filter((item) => item !== key));
      toast.success("兑换码已删除");
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败";
      toast.error(message);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedKeys.length === 0) {
      toast.error("请先选择兑换码");
      return;
    }
    const confirmed = window.confirm(`确认批量删除 ${selectedKeys.length} 个兑换码？删除后无法通过后台恢复。`);
    if (!confirmed) {
      return;
    }
    try {
      await Promise.all(selectedKeys.map((key) => deleteAdminKey(key)));
      await loadKeys(true);
      setSelectedKeys([]);
      toast.success(`已删除 ${selectedKeys.length} 个兑换码`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量删除失败";
      toast.error(message);
    }
  };

  const exportCsv = () => {
    const headers = [
      "key",
      "full_key",
      "name",
      "customer_name",
      "channel",
      "package_name",
      "batch_code",
      "enabled",
      "is_valid",
      "credit_amount",
      "redeemed_status",
      "redeemed_by",
      "redeemed_at",
      "created_at",
      "expires_at",
    ];
    const escapeCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = filteredKeys.map((item) => [
      item.key,
      item.full_key || "",
      item.name,
      item.customer_name,
      item.channel,
      item.package_name,
      item.batch_code,
      item.enabled,
      item.is_valid,
      formatCreditAmount(item),
      formatRemaining(item),
      item.redeemed_by || "",
      item.redeemed_at || "",
      item.created_at_str || item.created_at,
      formatExpires(item),
    ]);
    const csv = [headers.join(","), ...rows.map((row) => row.map(escapeCell).join(","))].join("\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `redemption-codes-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">License Center</div>
          <h1 className="text-2xl font-semibold tracking-tight">兑换码管理</h1>
          <p className="text-sm text-stone-500">生成和管理用于前台用户兑换积分的兑换码，按套餐、批次、渠道追踪发放情况。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void loadKeys()}
            disabled={isLoading}
          >
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
            刷新
          </Button>
          <Button className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            生成兑换码
          </Button>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={exportCsv}
          >
            <Download className="size-4" />
            导出 CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-xs font-medium">全部兑换码</span>
              <Ticket className="size-4" />
            </div>
            <div className="text-3xl font-semibold tracking-tight text-stone-900">{summary.total}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-xs font-medium">可兑换</span>
              <CheckCircle2 className="size-4" />
            </div>
            <div className="text-3xl font-semibold tracking-tight text-emerald-600">{summary.available}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-xs font-medium">已兑换</span>
              <Ticket className="size-4" />
            </div>
            <div className="text-3xl font-semibold tracking-tight text-sky-600">{summary.redeemed}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-xs font-medium">总积分</span>
              <CheckCircle2 className="size-4" />
            </div>
            <div className="text-3xl font-semibold tracking-tight text-violet-600">{summary.creditTotal}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.9fr)]">
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
              <h2 className="text-lg font-semibold tracking-tight">兑换码列表</h2>
                <p className="text-sm text-stone-500">新生成的兑换码可直接复制完整码；历史记录如未保存 secret 只能复制编号。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-[220px]">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="搜索备注或兑换码前缀"
                    className="h-10 rounded-xl border-stone-200 bg-white pl-10"
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-10 w-[132px] rounded-xl border-stone-200 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="available">可兑换</SelectItem>
                    <SelectItem value="redeemed">已兑换</SelectItem>
                    <SelectItem value="disabled">已停用</SelectItem>
                    <SelectItem value="invalid">不可用</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={pageSize} onValueChange={setPageSize}>
                  <SelectTrigger className="h-10 w-[116px] rounded-xl border-stone-200 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20">20 条/页</SelectItem>
                    <SelectItem value="50">50 条/页</SelectItem>
                    <SelectItem value="100">100 条/页</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-3 text-sm text-stone-500">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={allCurrentSelected}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedKeys((prev) => Array.from(new Set([...prev, ...pagedKeys.map((item) => item.key)])));
                        return;
                      }
                      setSelectedKeys((prev) => prev.filter((key) => !pagedKeys.some((item) => item.key === key)));
                    }}
                  />
                  <span>全选本页</span>
                </label>
                <span>共 {filteredKeys.length} 条</span>
                <span>已选 {selectedKeys.length} 条</span>
              </div>
              <Button
                variant="destructive"
                className="h-9 rounded-xl px-3"
                disabled={selectedKeys.length === 0}
                onClick={() => void handleDeleteSelected()}
              >
                <Trash2 className="size-4" />
                批量删除
              </Button>
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 py-12 text-sm text-stone-500">
                <LoaderCircle className="size-4 animate-spin" />
                正在加载兑换码
              </div>
            ) : filteredKeys.length === 0 ? (
              <div className="py-12 text-sm text-stone-500">没有符合条件的兑换码记录。</div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-stone-200/80 bg-white">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-stone-50 text-xs text-stone-500">
                      <tr>
                        <th className="px-3 py-2.5 font-medium">选择</th>
                        <th className="px-3 py-2.5 font-medium">名称</th>
                        <th className="px-3 py-2.5 font-medium">兑换状态</th>
                        <th className="px-3 py-2.5 font-medium">客户/渠道</th>
                        <th className="px-3 py-2.5 font-medium">套餐/批次</th>
                        <th className="px-3 py-2.5 font-medium">积分</th>
                        <th className="px-3 py-2.5 font-medium">兑换用户</th>
                        <th className="px-3 py-2.5 font-medium">时间</th>
                        <th className="px-3 py-2.5 font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedKeys.map((item) => (
                        <tr key={item.key} className="border-t border-stone-100 align-top">
                          <td className="px-3 py-2.5">
                            <Checkbox
                              checked={selectedKeys.includes(item.key)}
                              onCheckedChange={(checked) => {
                                setSelectedKeys((prev) =>
                                  checked ? Array.from(new Set([...prev, item.key])) : prev.filter((key) => key !== item.key),
                                );
                              }}
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="max-w-[280px] space-y-1">
                              <div className="truncate font-medium text-stone-900">{item.name || item.key}</div>
                              <div className="truncate font-mono text-[11px] text-stone-500">
                                {item.full_key_available ? item.full_key : `编号 ${item.key}`}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1.5">
                              <Badge variant={item.enabled ? "success" : "secondary"}>{item.enabled ? "启用" : "停用"}</Badge>
                              <Badge variant={item.redeemed_at ? "info" : item.is_valid ? "success" : "warning"}>
                                {item.redeemed_at ? "已兑换" : item.is_valid ? "可兑换" : "不可用"}
                              </Badge>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                            <div>{item.customer_name || "—"}</div>
                            <div>{item.channel || "—"}</div>
                          </td>
                          <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                            <div>{item.package_name || "—"}</div>
                            <div>{item.batch_code || "—"}</div>
                          </td>
                          <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                            <div>{formatCreditAmount(item)} 点</div>
                            <div>{formatRemaining(item)}</div>
                          </td>
                          <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                            <div className="max-w-[180px] truncate font-mono">{item.redeemed_by || "—"}</div>
                            <div>{item.redeemed_at ? new Date(item.redeemed_at * 1000).toLocaleString("zh-CN") : "未兑换"}</div>
                          </td>
                          <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                            <div>{item.created_at_str || "—"}</div>
                            <div>{formatExpires(item)}</div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-lg border-stone-200 px-2.5 text-xs text-stone-700"
                                onClick={() => {
                                  const copyValue = item.full_key || item.key;
                                  void navigator.clipboard.writeText(copyValue);
                                  toast.success(item.full_key ? "完整兑换码已复制" : "历史兑换码仅能复制编号");
                                }}
                              >
                                <Copy className="size-3.5" />
                                {item.full_key ? "复制" : "编号"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-lg border-stone-200 px-2.5 text-xs text-stone-700"
                                onClick={() => void toggleEnabled(item)}
                              >
                                {item.enabled ? "停用" : "启用"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-lg border-stone-200 px-2.5 text-xs text-stone-700"
                                onClick={() => void handleReset(item.key)}
                                disabled={!item.redeemed_at}
                              >
                                <RotateCcw className="size-3.5" />
                                重置
                              </Button>
                              <Input
                                value={topUpValue}
                                onChange={(event) => setTopUpValue(event.target.value)}
                                className="h-8 w-20 rounded-lg border-stone-200 bg-white px-2 text-xs"
                                disabled={Boolean(item.redeemed_at)}
                              />
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-lg border-stone-200 px-2.5 text-xs text-stone-700"
                                onClick={() => void handleTopUp(item.key)}
                                disabled={Boolean(item.redeemed_at)}
                              >
                                加额
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-lg border-rose-200 bg-rose-50 px-2.5 text-xs text-rose-600 hover:bg-rose-100"
                                onClick={() => void handleDelete(item.key)}
                              >
                                <Trash2 className="size-3.5" />
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col gap-3 border-t border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    第 {safePage} / {pageCount} 页，当前显示 {pagedKeys.length} 条
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs text-stone-700"
                      disabled={safePage <= 1}
                      onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      variant="outline"
                      className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs text-stone-700"
                      disabled={safePage >= pageCount}
                      onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="space-y-4 p-5">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">套餐发放</h2>
                <p className="text-sm text-stone-500">按套餐统计发码、兑换和积分。</p>
              </div>
              <div className="space-y-3">
                {packageStats.length === 0 ? (
                  <div className="text-sm text-stone-500">暂无套餐数据。</div>
                ) : (
                  packageStats.map((item) => (
                    <div key={item.name} className="rounded-2xl border border-stone-200/80 bg-white p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-stone-900">{item.name}</div>
                        <Badge variant="outline">{item.total} 个</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-stone-500">
                        <div className="rounded-xl bg-stone-50 px-3 py-2">已兑换 {item.redeemed}</div>
                        <div className="rounded-xl bg-stone-50 px-3 py-2">积分 {item.credit}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="space-y-4 p-5">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">批次概况</h2>
                <p className="text-sm text-stone-500">用于核对代理、渠道或活动批次。</p>
              </div>
              <div className="space-y-3">
                {batchStats.length === 0 ? (
                  <div className="text-sm text-stone-500">暂无批次数据。</div>
                ) : (
                  batchStats.map((item) => (
                    <div key={item.name} className="flex items-center justify-between rounded-2xl border border-stone-200/80 bg-white p-4">
                      <div className="max-w-[220px] truncate text-sm font-medium text-stone-800">{item.name}</div>
                      <Badge variant="outline">{item.total} 个</Badge>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="space-y-3 p-5 text-sm leading-6 text-stone-600">
              <h2 className="text-lg font-semibold tracking-tight text-stone-900">当前规则</h2>
              <div>兑换码只用于给前台用户增加积分，不再作为调用 API 的凭证。</div>
              <div>新生成的完整兑换码会保留在后台列表中；历史兑换码若只有编号则不能直接兑换。</div>
              <div>已兑换的兑换码不可加额，只有重置后才可再次兑换。</div>
              <div>管理员访问凭证不在此页面管理。</div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(96vw,760px)] rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle>生成新兑换码</DialogTitle>
            <DialogDescription>支持套餐模板和批量发码。完整兑换码只会在生成后展示这一次。</DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 lg:grid-cols-[1fr_1.05fr]">
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">套餐模板</label>
                <Select value={templateId} onValueChange={applyTemplate}>
                  <SelectTrigger className="rounded-xl border-stone-200 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {packageTemplates.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">备注名称</label>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：代理商 A / 客户 001" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-stone-700">客户名称</label>
                  <Input
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="例如：张三 / 某工作室"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-stone-700">渠道</label>
                  <Input
                    value={channel}
                    onChange={(event) => setChannel(event.target.value)}
                    placeholder="例如：微信 / 抖音 / 代理 A"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-stone-700">套餐名称</label>
                  <Input
                    value={packageName}
                    onChange={(event) => setPackageName(event.target.value)}
                    placeholder="例如：入门版 / 专业版"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-stone-700">批次号</label>
                  <Input
                    value={batchCode}
                    onChange={(event) => setBatchCode(event.target.value)}
                    placeholder="例如：20260423-A"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-stone-700">兑换积分</label>
                  <Input value={maxUsage} onChange={(event) => setMaxUsage(event.target.value)} placeholder="兑换后增加的积分" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-stone-700">有效期天数</label>
                  <Input value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} placeholder="0 表示永不过期" />
                </div>
              </div>

            </div>

            <div className="space-y-4">
              <div className="rounded-2xl bg-stone-50 p-4">
                <div className="text-sm font-medium text-stone-700">批量发码</div>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-600">数量</label>
                    <Input value={bulkCount} onChange={(event) => setBulkCount(event.target.value)} placeholder="1-50" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-600">批次前缀</label>
                    <Input value={bulkPrefix} onChange={(event) => setBulkPrefix(event.target.value)} placeholder="例如 vip-a" />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">生成结果</label>
                <Textarea
                  value={fullKeys.join("\n")}
                  readOnly
                  placeholder="生成后的完整兑换码会显示在这里，可一次性复制发给客户。"
                  className="min-h-52 rounded-2xl border-stone-200 bg-white font-mono text-xs"
                />
              </div>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                disabled={fullKeys.length === 0}
                onClick={() => {
                  void navigator.clipboard.writeText(fullKeys.join("\n"));
                  toast.success("完整兑换码已复制");
                }}
              >
                <Copy className="size-4" />
                复制全部完整兑换码
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="secondary" className="h-10 rounded-xl bg-stone-100 px-4 text-stone-700" onClick={() => setOpen(false)}>
              关闭
            </Button>
            <Button className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => void handleCreateKeys()} disabled={isSubmitting}>
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {Math.max(1, Number(bulkCount) || 1) > 1 ? "批量生成" : "立即生成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
