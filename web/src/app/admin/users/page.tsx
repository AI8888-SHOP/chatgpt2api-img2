"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, KeyRound, LoaderCircle, Plus, RefreshCw, Search, Trash2, UserCog } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  adjustAdminUserQuota,
  clearAdminUserImageConversations,
  createAdminUser,
  deleteAdminUserImageConversation,
  deleteAdminUserApiKey,
  deleteAdminUser,
  fetchAdminUserDetail,
  fetchAdminUsers,
  updateAdminUser,
  type AdminImageConversationItem,
  type AdminUserSummary,
  type UserOwnedApiKey,
  type UserQuotaLedgerItem,
} from "@/lib/api";

type UserFormMode = "create" | "edit";

function formatTime(timestamp: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN");
}

function formatLedgerReason(reason: string) {
  const labels: Record<string, string> = {
    register_bonus: "注册赠送",
    admin_create: "后台创建",
    redeem: "兑换码兑换",
    admin_adjust: "后台调整",
    admin_set: "后台设置",
    consume: "生成扣减",
  };
  return labels[reason] || reason || "-";
}

function formatConversationCreatedAt(value: string) {
  const timestamp = Date.parse(value || "");
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString("zh-CN");
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const didLoadRef = useRef(false);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("50");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<UserFormMode>("create");
  const [editingUser, setEditingUser] = useState<AdminUserSummary | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [quota, setQuota] = useState("0");
  const [enabled, setEnabled] = useState(true);
  const [adjustValue, setAdjustValue] = useState("10");
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailUser, setDetailUser] = useState<AdminUserSummary | null>(null);
  const [detailKeys, setDetailKeys] = useState<UserOwnedApiKey[]>([]);
  const [detailLedger, setDetailLedger] = useState<UserQuotaLedgerItem[]>([]);
  const [detailConversations, setDetailConversations] = useState<AdminImageConversationItem[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<string | null>(null);
  const [isClearingConversations, setIsClearingConversations] = useState(false);

  const summary = useMemo(() => {
    const enabledCount = users.filter((item) => item.enabled).length;
    const quotaTotal = users.reduce((sum, item) => sum + Number(item.quota || 0), 0);
    const usageTotal = users.reduce((sum, item) => sum + Number(item.total_usage || 0), 0);
    return { enabledCount, quotaTotal, usageTotal };
  }, [users]);

  const pageCount = Math.max(1, Math.ceil(total / Number(pageSize || 50)));
  const safePage = Math.min(page, pageCount);

  const loadUsers = async (silent = false, targetPage = page) => {
    if (!silent) setIsLoading(true);
    try {
      const limit = Number(pageSize || 50);
      const data = await fetchAdminUsers({
        query: query.trim(),
        limit,
        offset: Math.max(0, targetPage - 1) * limit,
      });
      setUsers(data.users);
      setTotal(data.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadUsers();
  }, []);

  useEffect(() => {
    if (!didLoadRef.current) return;
    void loadUsers(true);
  }, [page, pageSize]);

  const openCreate = () => {
    setMode("create");
    setEditingUser(null);
    setEmail("");
    setPassword("");
    setQuota("0");
    setEnabled(true);
    setOpen(true);
  };

  const openEdit = (user: AdminUserSummary) => {
    setMode("edit");
    setEditingUser(user);
    setEmail(user.email);
    setPassword("");
    setQuota(String(user.quota || 0));
    setEnabled(user.enabled);
    setOpen(true);
  };

  const saveUser = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      toast.error("请输入邮箱");
      return;
    }
    if (mode === "create" && !password) {
      toast.error("请输入密码");
      return;
    }
    setIsSaving(true);
    try {
      if (mode === "create") {
        await createAdminUser({
          email: normalizedEmail,
          password,
          quota: Math.max(0, Number(quota) || 0),
          enabled,
        });
        toast.success("用户已创建");
      } else if (editingUser) {
        await updateAdminUser(editingUser.id, {
          email: normalizedEmail,
          password: password || undefined,
          quota: Math.max(0, Number(quota) || 0),
          enabled,
        });
        toast.success("用户已更新");
      }
      setOpen(false);
      await loadUsers(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存用户失败");
    } finally {
      setIsSaving(false);
    }
  };

  const toggleUser = async (user: AdminUserSummary) => {
    try {
      await updateAdminUser(user.id, { enabled: !user.enabled });
      await loadUsers(true);
      toast.success(user.enabled ? "用户已停用" : "用户已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新状态失败");
    }
  };

  const adjustQuota = async (user: AdminUserSummary, sign: 1 | -1) => {
    const amount = Math.max(1, Number(adjustValue) || 1) * sign;
    try {
      await adjustAdminUserQuota(user.id, amount);
      await loadUsers(true);
      toast.success(amount > 0 ? `已增加 ${amount} 点积分` : `已扣减 ${Math.abs(amount)} 点积分`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "调整积分失败");
    }
  };

  const removeUser = async (user: AdminUserSummary) => {
    const confirmed = window.confirm(`确认删除用户 ${user.email}？`);
    if (!confirmed) return;
    try {
      await deleteAdminUser(user.id);
      await loadUsers(true);
      toast.success("用户已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除用户失败");
    }
  };

  const openDetail = async (user: AdminUserSummary) => {
    setDetailOpen(true);
    setDetailUser(user);
    setDetailKeys([]);
    setDetailLedger([]);
    setDetailConversations([]);
    setIsLoadingDetail(true);
    try {
      const data = await fetchAdminUserDetail(user.id);
      setDetailUser(data.user);
      setDetailKeys(data.api_keys);
      setDetailLedger(data.quota_ledger?.records || []);
      setDetailConversations(data.image_conversations?.items || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户详情失败");
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const removeUserApiKey = async (key: UserOwnedApiKey) => {
    if (!detailUser) return;
    const confirmed = window.confirm(`确认删除 API Key「${key.name || key.key}」？`);
    if (!confirmed) return;
    setDeletingKey(key.key);
    try {
      await deleteAdminUserApiKey(detailUser.id, key.key);
      const data = await fetchAdminUserDetail(detailUser.id);
      setDetailUser(data.user);
      setDetailKeys(data.api_keys);
      setDetailLedger(data.quota_ledger?.records || []);
      setDetailConversations(data.image_conversations?.items || []);
      toast.success("API Key 已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除 API Key 失败");
    } finally {
      setDeletingKey(null);
    }
  };

  const removeImageConversation = async (conversation: AdminImageConversationItem) => {
    if (!detailUser) return;
    const confirmed = window.confirm(`确认删除画图历史「${conversation.title || conversation.id}」？`);
    if (!confirmed) return;
    setDeletingConversation(conversation.id);
    try {
      await deleteAdminUserImageConversation(detailUser.id, conversation.id);
      const data = await fetchAdminUserDetail(detailUser.id);
      setDetailUser(data.user);
      setDetailKeys(data.api_keys);
      setDetailLedger(data.quota_ledger?.records || []);
      setDetailConversations(data.image_conversations?.items || []);
      toast.success("画图历史已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除画图历史失败");
    } finally {
      setDeletingConversation(null);
    }
  };

  const clearImageConversations = async () => {
    if (!detailUser) return;
    const confirmed = window.confirm(`确认清空用户 ${detailUser.email} 的全部画图历史？`);
    if (!confirmed) return;
    setIsClearingConversations(true);
    try {
      const result = await clearAdminUserImageConversations(detailUser.id);
      const data = await fetchAdminUserDetail(detailUser.id);
      setDetailUser(data.user);
      setDetailKeys(data.api_keys);
      setDetailLedger(data.quota_ledger?.records || []);
      setDetailConversations(data.image_conversations?.items || []);
      toast.success(`已清空 ${result.deleted} 条画图历史`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清空画图历史失败");
    } finally {
      setIsClearingConversations(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Users</div>
          <h1 className="text-2xl font-semibold tracking-tight">用户管理</h1>
          <p className="text-sm text-stone-500">管理前台用户、登录状态、积分和账号启停。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4" onClick={() => void loadUsers()}>
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
            刷新
          </Button>
          <Button className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={openCreate}>
            <Plus className="size-4" />
            新建用户
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          ["全部用户", total],
          ["启用用户", summary.enabledCount],
          ["剩余积分", summary.quotaTotal],
        ].map(([label, value]) => (
          <Card key={label} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="p-5">
              <div className="text-xs font-medium text-stone-400">{label}</div>
              <div className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">用户列表</h2>
              <p className="text-sm text-stone-500">可直接修改积分、启停账号或重置密码。</p>
            </div>
            <div className="flex gap-2">
              <div className="relative min-w-[260px]">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setPage(1);
                      void loadUsers(false, 1);
                    }
                  }}
                  placeholder="搜索邮箱"
                  className="h-10 rounded-xl border-stone-200 bg-white pl-10"
                />
              </div>
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(event.target.value);
                  setPage(1);
                }}
                className="h-10 rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-700"
              >
                <option value="20">20 条/页</option>
                <option value="50">50 条/页</option>
                <option value="100">100 条/页</option>
              </select>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-stone-200 bg-white px-4"
                onClick={() => {
                  setPage(1);
                  void loadUsers(false, 1);
                }}
              >
                搜索
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 py-12 text-sm text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />
              正在加载用户
            </div>
          ) : users.length === 0 ? (
            <div className="py-12 text-sm text-stone-500">暂无用户。</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-stone-200/80 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-stone-50 text-xs text-stone-500">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">用户</th>
                      <th className="px-3 py-2.5 font-medium">状态</th>
                      <th className="px-3 py-2.5 font-medium">积分</th>
                      <th className="px-3 py-2.5 font-medium">用量</th>
                      <th className="px-3 py-2.5 font-medium">时间</th>
                      <th className="px-3 py-2.5 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id} className="border-t border-stone-100 align-top">
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-stone-900">{user.email}</div>
                          <div className="font-mono text-[11px] text-stone-400">{user.id}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant={user.enabled ? "success" : "secondary"}>{user.enabled ? "启用" : "停用"}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-stone-700">{user.quota}</td>
                        <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                          <div>已用 {user.total_usage}</div>
                          <div>累计获得 {user.total_redeemed}</div>
                        </td>
                        <td className="px-3 py-2.5 text-xs leading-5 text-stone-600">
                          <div>创建 {formatTime(user.created_at)}</div>
                          <div>更新 {formatTime(user.updated_at)}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            <Button variant="outline" size="sm" className="h-8 rounded-lg border-stone-200 px-2.5 text-xs" onClick={() => void openDetail(user)}>
                              <Eye className="size-3.5" />
                              详情
                            </Button>
                            <Button variant="outline" size="sm" className="h-8 rounded-lg border-stone-200 px-2.5 text-xs" onClick={() => openEdit(user)}>
                              <UserCog className="size-3.5" />
                              编辑
                            </Button>
                            <Button variant="outline" size="sm" className="h-8 rounded-lg border-stone-200 px-2.5 text-xs" onClick={() => void toggleUser(user)}>
                              {user.enabled ? "停用" : "启用"}
                            </Button>
                            <Input value={adjustValue} onChange={(event) => setAdjustValue(event.target.value)} className="h-8 w-20 rounded-lg border-stone-200 px-2 text-xs" />
                            <Button variant="outline" size="sm" className="h-8 rounded-lg border-stone-200 px-2.5 text-xs" onClick={() => void adjustQuota(user, 1)}>
                              加额
                            </Button>
                            <Button variant="outline" size="sm" className="h-8 rounded-lg border-stone-200 px-2.5 text-xs" onClick={() => void adjustQuota(user, -1)}>
                              扣额
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 rounded-lg border-rose-200 bg-rose-50 px-2.5 text-xs text-rose-600 hover:bg-rose-100"
                              onClick={() => void removeUser(user)}
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
                  第 {safePage} / {pageCount} 页，共 {total} 个用户，当前显示 {users.length} 个
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(96vw,560px)] rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle>{mode === "create" ? "新建用户" : "编辑用户"}</DialogTitle>
            <DialogDescription>{mode === "create" ? "创建可登录前台的用户账号。" : "留空密码表示不修改密码。"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">邮箱</label>
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">密码</label>
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "create" ? "至少 6 位" : "留空不修改"} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">积分</label>
                <Input type="number" min={0} value={quota} onChange={(event) => setQuota(event.target.value)} />
              </div>
              <label className="mt-8 flex items-center gap-2 text-sm text-stone-600">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                启用账号
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl border-stone-200" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button className="rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={() => void saveUser()} disabled={isSaving}>
              {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="w-[min(96vw,860px)] rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle>用户详情</DialogTitle>
            <DialogDescription>查看用户积分、调用用量和该用户创建的前台 API Key。</DialogDescription>
          </DialogHeader>

          {isLoadingDetail ? (
            <div className="flex items-center gap-2 py-12 text-sm text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />
              正在加载用户详情
            </div>
          ) : detailUser ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                {[
                  ["状态", detailUser.enabled ? "启用" : "停用"],
                  ["剩余积分", detailUser.quota],
                  ["已用积分", detailUser.total_usage],
                  ["累计兑换", detailUser.total_redeemed],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-stone-200 bg-stone-50 p-4">
                    <div className="text-xs text-stone-400">{label}</div>
                    <div className="mt-2 text-xl font-semibold text-stone-900">{value}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-stone-200 bg-white p-4">
                <div className="flex flex-col gap-1 text-sm">
                  <div className="font-medium text-stone-900">{detailUser.email}</div>
                  <div className="font-mono text-xs text-stone-400">{detailUser.id}</div>
                  <div className="text-xs text-stone-500">
                    创建 {formatTime(detailUser.created_at)}，更新 {formatTime(detailUser.updated_at)}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold tracking-tight">积分流水</h3>
                    <p className="text-sm text-stone-500">记录兑换、后台调整和成功生成后的扣减。</p>
                  </div>
                  <Badge variant="outline">{detailLedger.length} 条</Badge>
                </div>

                {detailLedger.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 p-8 text-sm text-stone-500">
                    暂无积分流水。
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-sm">
                        <thead className="bg-stone-50 text-xs text-stone-500">
                          <tr>
                            <th className="px-3 py-2.5 font-medium">来源</th>
                            <th className="px-3 py-2.5 font-medium">变化</th>
                            <th className="px-3 py-2.5 font-medium">余额</th>
                            <th className="px-3 py-2.5 font-medium">关联</th>
                            <th className="px-3 py-2.5 font-medium">时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailLedger.map((item) => (
                            <tr key={item.id} className="border-t border-stone-100 align-top">
                              <td className="px-3 py-2.5 text-stone-700">{formatLedgerReason(item.reason)}</td>
                              <td className={`px-3 py-2.5 font-semibold ${item.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                {item.amount >= 0 ? "+" : ""}
                                {item.amount}
                              </td>
                              <td className="px-3 py-2.5 text-stone-700">{item.balance_after}</td>
                              <td className="px-3 py-2.5">
                                <div className="max-w-[220px] truncate font-mono text-xs text-stone-500">{item.reference || "-"}</div>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-stone-500">{formatTime(item.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold tracking-tight">画图历史</h3>
                    <p className="text-sm text-stone-500">用户最近同步到后端的画图会话。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{detailConversations.length} 条</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-lg border-rose-200 bg-rose-50 px-2.5 text-xs text-rose-600 hover:bg-rose-100"
                      onClick={() => void clearImageConversations()}
                      disabled={detailConversations.length === 0 || isClearingConversations}
                    >
                      {isClearingConversations ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                      清空
                    </Button>
                  </div>
                </div>

                {detailConversations.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 p-8 text-sm text-stone-500">
                    暂无后端画图历史。
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-sm">
                        <thead className="bg-stone-50 text-xs text-stone-500">
                          <tr>
                            <th className="px-3 py-2.5 font-medium">会话</th>
                            <th className="px-3 py-2.5 font-medium">模式</th>
                            <th className="px-3 py-2.5 font-medium">状态</th>
                            <th className="px-3 py-2.5 font-medium">图片</th>
                            <th className="px-3 py-2.5 font-medium">时间</th>
                            <th className="px-3 py-2.5 font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailConversations.map((item) => (
                            <tr key={item.id} className="border-t border-stone-100 align-top">
                              <td className="px-3 py-2.5">
                                <div className="max-w-[300px] truncate font-medium text-stone-900">{item.title || item.prompt || item.id}</div>
                                <div className="max-w-[300px] truncate text-xs text-stone-500">{item.prompt || "-"}</div>
                              </td>
                              <td className="px-3 py-2.5 text-stone-700">{item.mode === "edit" ? "编辑" : "生成"}</td>
                              <td className="px-3 py-2.5">
                                <Badge variant={item.status === "success" ? "success" : item.status === "error" ? "warning" : "secondary"}>
                                  {item.status === "success" ? "成功" : item.status === "error" ? "失败" : "生成中"}
                                </Badge>
                              </td>
                              <td className="px-3 py-2.5 text-stone-700">
                                {(item.images || []).filter((image) => image.status === "success" && (image.url || image.b64_json)).length} / {item.count || item.images?.length || 0}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-stone-500">{formatConversationCreatedAt(item.createdAt)}</td>
                              <td className="px-3 py-2.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 rounded-lg border-rose-200 bg-rose-50 px-2.5 text-xs text-rose-600 hover:bg-rose-100"
                                  onClick={() => void removeImageConversation(item)}
                                  disabled={deletingConversation === item.id}
                                >
                                  {deletingConversation === item.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                                  删除
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold tracking-tight">前台 API Keys</h3>
                    <p className="text-sm text-stone-500">这些 Key 由用户在前台设置页创建。</p>
                  </div>
                  <Badge variant="outline">{detailKeys.length} 个</Badge>
                </div>

                {detailKeys.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 p-8 text-sm text-stone-500">
                    该用户还没有创建前台 API Key。
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-sm">
                        <thead className="bg-stone-50 text-xs text-stone-500">
                          <tr>
                            <th className="px-3 py-2.5 font-medium">名称</th>
                            <th className="px-3 py-2.5 font-medium">状态</th>
                            <th className="px-3 py-2.5 font-medium">Key</th>
                            <th className="px-3 py-2.5 font-medium">时间</th>
                            <th className="px-3 py-2.5 font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailKeys.map((item) => (
                            <tr key={item.key} className="border-t border-stone-100 align-top">
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2 font-medium text-stone-900">
                                  <KeyRound className="size-3.5 text-stone-400" />
                                  {item.name || "未命名"}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge variant={item.enabled ? "success" : "secondary"}>
                                  {item.enabled ? "启用" : "停用"}
                                </Badge>
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="max-w-[260px] truncate font-mono text-xs text-stone-500">{item.key}</div>
                              </td>
                              <td className="px-3 py-2.5 text-xs leading-5 text-stone-500">
                                <div>创建 {formatTime(item.created_at)}</div>
                                <div>最近使用 {formatTime(item.last_used_at)}</div>
                              </td>
                              <td className="px-3 py-2.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 rounded-lg border-rose-200 bg-rose-50 px-2.5 text-xs text-rose-600 hover:bg-rose-100"
                                  onClick={() => void removeUserApiKey(item)}
                                  disabled={deletingKey === item.key}
                                >
                                  {deletingKey === item.key ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                                  删除
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" className="rounded-xl border-stone-200" onClick={() => setDetailOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
