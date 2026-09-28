"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { adminLogin } from "@/lib/api";
import { setStoredAuthKey } from "@/store/auth";

export default function AdminLoginPage() {
  const router = useRouter();
  const [identity, setIdentity] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleLogin = async () => {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
      toast.error("请输入管理员密钥");
      return;
    }

    setIsSubmitting(true);
    try {
      const normalizedIdentity = identity.trim().replace(/\|/g, "").slice(0, 80);
      const scopedAuthKey = normalizedIdentity ? `${normalizedIdentity}|${normalizedAuthKey}` : normalizedAuthKey;
      await adminLogin(scopedAuthKey);
      await setStoredAuthKey("admin", scopedAuthKey);
      router.replace("/admin/accounts");
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
      <Card className="w-full max-w-[560px] rounded-[30px] border-white/80 bg-white/95 shadow-[0_28px_90px_rgba(28,25,23,0.10)]">
        <CardContent className="space-y-7 p-6 sm:p-8">
          <div className="space-y-4 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-[18px] bg-stone-950 text-white shadow-sm">
              <ShieldCheck className="size-5" />
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-stone-950">后台管理登录</h1>
              <p className="text-sm leading-6 text-stone-500">
                使用管理员密钥进入号池管理、系统设置和密钥发放后台。
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <label htmlFor="admin-identity" className="block text-sm font-medium text-stone-700">
              管理员标识
            </label>
            <Input
              id="admin-identity"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleLogin();
                }
              }}
              placeholder="例如：张三 / 运营A / 值班账号"
              className="h-13 rounded-2xl border-stone-200 bg-white px-4"
            />
          </div>

          <div className="space-y-3">
            <label htmlFor="admin-auth-key" className="block text-sm font-medium text-stone-700">
              管理员密钥
            </label>
            <Input
              id="admin-auth-key"
              type="password"
              value={authKey}
              onChange={(event) => setAuthKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleLogin();
                }
              }}
              placeholder="请输入管理员密钥"
              className="h-13 rounded-2xl border-stone-200 bg-white px-4"
            />
          </div>

          <Button
            className="h-13 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
            onClick={() => void handleLogin()}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            登录后台
          </Button>

          <div className="text-center text-sm text-stone-500">
            用户画图入口：
            <Link href="/login" className="ml-1 font-medium text-stone-950 hover:text-stone-700">
              前往画图登录
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
