"use client";

import { CheckCircle2, Copy, Gift, KeyRound, LoaderCircle, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  createUserApiKey,
  deleteUserApiKey,
  fetchUserKeyInfo,
  fetchUserApiKeys,
  fetchUserInviteInfo,
  redeemUserCode,
  updateUserApiKey,
  type UserInviteInfo,
  type UserOwnedApiKey,
} from "@/lib/api";

function formatTime(value: number) {
  if (!value) {
    return "从未";
  }
  return new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
}

async function copyText(value: string, message = "已复制") {
  await navigator.clipboard.writeText(value);
  toast.success(message);
}

export default function UserApiKeysPage() {
  const [items, setItems] = useState<UserOwnedApiKey[]>([]);
  const [invite, setInvite] = useState<UserInviteInfo | null>(null);
  const [availableQuota, setAvailableQuota] = useState("加载中");
  const [redeemCode, setRedeemCode] = useState("");
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isRedeeming, setIsRedeeming] = useState(false);
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);
  const inviteLink =
    invite && typeof window !== "undefined"
      ? `${window.location.origin}/login?invite=${encodeURIComponent(invite.code)}`
      : "";

  const loadItems = async () => {
    setIsLoading(true);
    try {
      const [keyData, inviteData, quotaData] = await Promise.all([fetchUserApiKeys(), fetchUserInviteInfo(), fetchUserKeyInfo()]);
      setItems(keyData.api_keys);
      setInvite(inviteData.invite);
      setAvailableQuota(quotaData.remaining === -1 ? "无限" : String(quotaData.remaining));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载 API Key 失败");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRedeem = async () => {
    const code = redeemCode.trim();
    if (!code) {
      toast.error("请输入兑换码");
      return;
    }
    setIsRedeeming(true);
    try {
      const data = await redeemUserCode(code);
      setRedeemCode("");
      setAvailableQuota(data.user.remaining === -1 ? "无限" : String(data.user.remaining));
      toast.success(`已兑换 ${data.amount} 点积分`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "兑换失败");
    } finally {
      setIsRedeeming(false);
    }
  };

  useEffect(() => {
    void loadItems();
  }, []);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const data = await createUserApiKey(name.trim());
      setItems((current) => [data.api_key, ...current]);
      setCreatedKey(data.key);
      setName("");
      toast.success("API Key 已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建 API Key 失败");
    } finally {
      setIsCreating(false);
    }
  };

  const toggleEnabled = async (item: UserOwnedApiKey) => {
    setMutatingKey(item.key);
    try {
      const data = await updateUserApiKey(item.key, { enabled: !item.enabled });
      setItems((current) => current.map((value) => (value.key === item.key ? data.api_key : value)));
      toast.success(data.api_key.enabled ? "API Key 已启用" : "API Key 已停用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新 API Key 失败");
    } finally {
      setMutatingKey(null);
    }
  };

  const handleDelete = async (item: UserOwnedApiKey) => {
    if (!window.confirm(`确认删除 API Key「${item.name || item.key}」？删除后不可恢复。`)) {
      return;
    }
    setMutatingKey(item.key);
    try {
      await deleteUserApiKey(item.key);
      setItems((current) => current.filter((value) => value.key !== item.key));
      toast.success("API Key 已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除 API Key 失败");
    } finally {
      setMutatingKey(null);
    }
  };

  return (
    <section className="space-y-3 sm:space-y-6">
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-3 p-4 sm:space-y-5 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-stone-100 sm:size-10">
                <Copy className="size-5 text-stone-600" />
              </div>
              <div className="min-w-0">
                <h1 className="text-base font-semibold tracking-tight sm:text-lg">邀请好友</h1>
                <p className="text-xs text-stone-500 sm:text-sm">
                  好友通过你的邀请链接注册后，你获得 {invite?.inviter_quota || 0} 积分，好友获得 {invite?.invited_quota || 0} 积分。
                </p>
              </div>
            </div>
            <Badge variant={invite?.enabled === false ? "secondary" : "success"} className="w-fit rounded-md px-2.5 py-1">
              {invite?.enabled === false ? "未开启" : `已邀请 ${invite?.total_invites || 0} 人`}
            </Badge>
          </div>

          {invite ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <code className="min-w-0 flex-1 truncate rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 sm:break-all">
                {inviteLink}
              </code>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-stone-200 bg-white text-stone-700"
                onClick={() => void copyText(inviteLink, "邀请链接已复制")}
                disabled={invite.enabled === false}
              >
                <Copy className="size-4" />
                复制邀请链接
              </Button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-6">
              <LoaderCircle className="size-5 animate-spin text-stone-400" />
            </div>
          ) : null}

          {invite?.recent?.length ? (
            <div className="hidden rounded-xl border border-stone-200 bg-white sm:block">
              <div className="border-b border-stone-100 px-4 py-2 text-xs font-medium text-stone-500">最近邀请</div>
              <div className="divide-y divide-stone-100">
                {invite.recent.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span className="truncate text-stone-700">{item.invited_email || item.invited_user_id}</span>
                    <span className="shrink-0 text-xs text-stone-500">{formatTime(item.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-3 p-4 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-stone-100 sm:size-10">
                <Gift className="size-5 text-stone-600" />
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight sm:text-lg">积分兑换</h2>
                <p className="text-xs text-stone-500 sm:text-sm">当前积分 {availableQuota}</p>
              </div>
            </div>
            <div className="flex gap-2 sm:min-w-[360px]">
              <Input
                value={redeemCode}
                onChange={(event) => setRedeemCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleRedeem();
                  }
                }}
                placeholder="输入兑换码"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
              <Button
                className="h-10 shrink-0 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800"
                onClick={() => void handleRedeem()}
                disabled={isRedeeming}
              >
                {isRedeeming ? <LoaderCircle className="size-4 animate-spin" /> : null}
                兑换
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-4 p-4 sm:space-y-6 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-stone-100 sm:size-10">
                <KeyRound className="size-5 text-stone-600" />
              </div>
              <div>
                <h1 className="text-base font-semibold tracking-tight sm:text-lg">我的 API</h1>
                <p className="text-xs text-stone-500 sm:text-sm">创建自己的 API Key，用同一账户积分调用生图接口。</p>
              </div>
            </div>
            <Badge variant="outline" className="w-fit rounded-md px-2.5 py-1">
              {items.length} 个 Key
            </Badge>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_140px]">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Key 名称，例如：本地脚本"
              className="h-11 rounded-xl border-stone-200 bg-white"
            />
            <Button className="h-11 rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleCreate()} disabled={isCreating}>
              {isCreating ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              创建 Key
            </Button>
          </div>

          {createdKey ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-800">
                <CheckCircle2 className="size-4" />
                完整 API Key 只显示一次
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <code className="min-w-0 flex-1 break-all rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs text-stone-700">
                  {createdKey}
                </code>
                <Button variant="outline" className="h-10 rounded-xl border-emerald-200 bg-white text-emerald-700" onClick={() => void copyText(createdKey, "完整 API Key 已复制")}>
                  <Copy className="size-4" />
                  复制
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <LoaderCircle className="size-5 animate-spin text-stone-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-sm text-stone-500">还没有 API Key。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">Key ID</th>
                    <th className="px-4 py-3 font-medium">时间</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.key} className="border-b border-stone-100 align-top last:border-0">
                      <td className="px-4 py-3 font-medium text-stone-900">{item.name || "未命名"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={item.enabled ? "success" : "secondary"}>{item.enabled ? "启用" : "停用"}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <button type="button" className="font-mono text-xs text-stone-500 hover:text-stone-900" onClick={() => void copyText(item.key, "Key ID 已复制")}>
                          {item.key}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs leading-5 text-stone-500">
                        <div>创建 {formatTime(item.created_at)}</div>
                        <div>最近使用 {formatTime(item.last_used_at)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" className="h-8 rounded-lg border-stone-200 bg-white px-2.5 text-xs" onClick={() => void toggleEnabled(item)} disabled={mutatingKey === item.key}>
                            {item.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                            {item.enabled ? "停用" : "启用"}
                          </Button>
                          <Button variant="outline" className="h-8 rounded-lg border-rose-200 bg-rose-50 px-2.5 text-xs text-rose-600 hover:bg-rose-100" onClick={() => void handleDelete(item)} disabled={mutatingKey === item.key}>
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
          )}
        </CardContent>
      </Card>
    </section>
  );
}
