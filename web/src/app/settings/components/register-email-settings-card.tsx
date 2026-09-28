"use client";

import { LoaderCircle, MailCheck, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

import { useSettingsStore } from "../store";

export function RegisterEmailSettingsCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setConfigValue = useSettingsStore((state) => state.setConfigValue);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
            <MailCheck className="size-5 text-stone-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">注册邮箱验证</h2>
            <p className="text-sm text-stone-500">为前台自助注册配置邮箱验证码、域名白名单和 SMTP 发信账号。</p>
          </div>
        </div>

        {isLoadingConfig ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-stone-800">启用注册邮箱验证码</span>
                <span className="block text-xs text-stone-500">开启后，新用户注册必须先接收并填写邮箱验证码。</span>
              </span>
              <Checkbox
                checked={config?.register_email_verification_enabled === true}
                onCheckedChange={(checked) => setConfigValue("register_email_verification_enabled", checked === true)}
              />
            </label>

            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">邮箱域名白名单</label>
              <Input
                value={String(config?.register_email_domain_whitelist || "")}
                onChange={(event) => setConfigValue("register_email_domain_whitelist", event.target.value)}
                placeholder="example.com, company.com"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
              <p className="text-xs text-stone-500">留空表示不限制。多个域名用逗号或换行分隔。</p>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">SMTP 主机</label>
                <Input value={String(config?.smtp_host || "")} onChange={(event) => setConfigValue("smtp_host", event.target.value)} placeholder="smtp.example.com" className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">SMTP 端口</label>
                <Input type="number" min={1} value={Number(config?.smtp_port || 587)} onChange={(event) => setConfigValue("smtp_port", Number(event.target.value) || 587)} className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">SMTP 用户名</label>
                <Input value={String(config?.smtp_username || "")} onChange={(event) => setConfigValue("smtp_username", event.target.value)} className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">SMTP 密码</label>
                <Input type="password" value={String(config?.smtp_password || "")} onChange={(event) => setConfigValue("smtp_password", event.target.value)} className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">发件人邮箱</label>
                <Input value={String(config?.smtp_from_email || "")} onChange={(event) => setConfigValue("smtp_from_email", event.target.value)} placeholder="noreply@example.com" className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">发件人名称</label>
                <Input value={String(config?.smtp_from_name || "")} onChange={(event) => setConfigValue("smtp_from_name", event.target.value)} placeholder="注册验证" className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
            </div>

            <label className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm font-medium text-stone-700">
              <Checkbox checked={config?.smtp_tls_enabled !== false} onCheckedChange={(checked) => setConfigValue("smtp_tls_enabled", checked === true)} />
              为 SMTP 连接启用 TLS 加密
            </label>

            <div className="flex justify-end">
              <Button className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void saveConfig()} disabled={isSavingConfig}>
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存邮箱设置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
