"use client";

import { LoaderCircle, LockKeyhole, Sparkles, UserPlus, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchUserRegisterConfig, registerUser, sendRegisterEmailCode, userLoginWithPassword } from "@/lib/api";
import { setStoredAuthKey } from "@/store/auth";

const highlights = ["支持文生图与编辑图", "自动保存历史会话", "参考图与遮罩工作流"];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [emailVerificationEnabled, setEmailVerificationEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const invite = (params.get("invite") || params.get("ref") || "").trim();
    if (invite) {
      setInviteCode(invite);
      setMode("register");
    }
    fetchUserRegisterConfig()
      .then((data) => {
        if (!active) return;
        setRegistrationEnabled(data.enabled);
        setEmailVerificationEnabled(data.email_verification_enabled);
        if (!data.enabled) {
          setMode("login");
        }
      })
      .catch(() => {
        if (active) {
          setRegistrationEnabled(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const handleLogin = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      toast.error("请输入邮箱和密码");
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === "register") {
        if (!registrationEnabled) {
          toast.error("当前未开放自助注册，请联系管理员创建账号");
          return;
        }
        if (emailVerificationEnabled && !verificationCode.trim()) {
          toast.error("请输入邮箱验证码");
          return;
        }
        await registerUser(normalizedEmail, password, verificationCode.trim(), inviteCode.trim());
        toast.success("注册成功，已自动登录");
      }
      const data = await userLoginWithPassword(normalizedEmail, password);
      await setStoredAuthKey("user", data.token);
      router.replace("/image");
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendCode = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      toast.error("请先填写邮箱");
      return;
    }
    setIsSendingCode(true);
    try {
      await sendRegisterEmailCode(normalizedEmail);
      toast.success("验证码已发送");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发送验证码失败");
    } finally {
      setIsSendingCode(false);
    }
  };

  return (
    <section className="relative grid min-h-[calc(100vh-1.5rem)] place-items-center overflow-hidden rounded-[32px] border border-white/55 bg-[linear-gradient(135deg,rgba(255,252,246,0.88),rgba(244,233,220,0.78)),radial-gradient(circle_at_top_left,rgba(241,186,102,0.22),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(171,125,82,0.18),transparent_28%)] px-4 py-6 shadow-[0_40px_120px_-56px_rgba(76,50,26,0.42)] sm:px-6">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-[radial-gradient(circle_at_left_center,_rgba(255,255,255,0.55),_transparent_64%)]" />
      <div className="relative grid w-full max-w-[1180px] gap-6 lg:grid-cols-[minmax(0,1.1fr)_460px] lg:items-center">
        <div className="hidden lg:block">
          <div className="max-w-[560px] space-y-7 px-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/65 bg-white/55 px-4 py-2 text-xs font-semibold uppercase tracking-[0.26em] text-stone-600">
              <Sparkles className="size-4" />
              Creative Workspace
            </div>
            <div className="space-y-4">
              <h1
                className="text-5xl leading-[1.02] font-semibold tracking-tight text-stone-950"
                style={{ fontFamily: '"Iowan Old Style","Palatino Linotype","Book Antiqua",serif' }}
              >
                进入更清晰的图像生成工作台。
              </h1>
              <p className="max-w-[46ch] text-base leading-8 text-stone-600">
                在一个页面里组织提示词、参考图、尺寸策略与结果浏览，减少反复切换与丢失上下文。
              </p>
            </div>
            <div className="grid gap-3">
              {highlights.map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-2xl border border-white/60 bg-white/50 px-4 py-3 text-stone-700 backdrop-blur-sm">
                  <div className="flex size-10 items-center justify-center rounded-2xl bg-[#9c6034] text-white shadow-[0_16px_30px_-20px_rgba(156,96,52,0.9)]">
                    <Wand2 className="size-4" />
                  </div>
                  <span className="text-sm font-medium">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Card className="glass-panel section-shell w-full rounded-[30px] border-white/60 bg-white/75 shadow-[0_32px_100px_-48px_rgba(53,34,16,0.5)]">
          <CardContent className="space-y-7 p-6 sm:p-8">
            <div className="space-y-4 text-center">
              <div className="mx-auto flex size-16 items-center justify-center rounded-[22px] bg-stone-950 text-white shadow-[0_18px_34px_-18px_rgba(0,0,0,0.72)]">
                <LockKeyhole className="size-6" />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-stone-950">{mode === "login" ? "登录工作台" : "注册账号"}</h1>
                <p className="text-sm leading-6 text-stone-500">使用邮箱和密码进入画图工作台，兑换码进入后再兑换积分。</p>
              </div>
            </div>

            <div className="space-y-3">
              <label htmlFor="email" className="block text-sm font-medium text-stone-700">
                邮箱
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleLogin();
                  }
                }}
                placeholder="name@example.com"
                className="h-14 rounded-2xl border-white/60 bg-white/80 px-4 text-[15px] shadow-none"
              />
            </div>

            <div className="space-y-3">
              <label htmlFor="password" className="block text-sm font-medium text-stone-700">
                密码
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleLogin();
                  }
                }}
                placeholder="至少 6 位"
                className="h-14 rounded-2xl border-white/60 bg-white/80 px-4 text-[15px] shadow-none"
              />
            </div>

            {mode === "register" && emailVerificationEnabled ? (
              <div className="space-y-3">
                <label htmlFor="verification-code" className="block text-sm font-medium text-stone-700">
                  邮箱验证码
                </label>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_128px]">
                  <Input
                    id="verification-code"
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleLogin();
                      }
                    }}
                    placeholder="6 位验证码"
                    className="h-14 rounded-2xl border-white/60 bg-white/80 px-4 text-[15px] shadow-none"
                  />
                  <Button
                    variant="outline"
                    className="h-14 rounded-2xl border-stone-200 bg-white/70 text-stone-700"
                    onClick={() => void handleSendCode()}
                    disabled={isSendingCode || isSubmitting}
                  >
                    {isSendingCode ? <LoaderCircle className="size-4 animate-spin" /> : null}
                    发送验证码
                  </Button>
                </div>
              </div>
            ) : null}

            {mode === "register" ? (
              <div className="space-y-3">
                <label htmlFor="invite-code" className="block text-sm font-medium text-stone-700">
                  邀请码
                </label>
                <Input
                  id="invite-code"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="可选"
                  className="h-14 rounded-2xl border-white/60 bg-white/80 px-4 text-[15px] shadow-none"
                />
              </div>
            ) : null}

            <Button
              className="h-14 w-full rounded-2xl bg-stone-950 text-white shadow-[0_20px_40px_-20px_rgba(28,25,23,0.88)] hover:bg-stone-800"
              onClick={() => void handleLogin()}
              disabled={isSubmitting}
            >
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {mode === "login" ? "进入工作台" : "注册并进入"}
            </Button>

            {registrationEnabled ? (
              <Button
                variant="outline"
                className="h-12 w-full rounded-2xl border-stone-200 bg-white/70 text-stone-700"
                onClick={() => {
                  setVerificationCode("");
                  setMode((value) => (value === "login" ? "register" : "login"));
                }}
                disabled={isSubmitting}
              >
                <UserPlus className="size-4" />
                {mode === "login" ? "没有账号，去注册" : "已有账号，去登录"}
              </Button>
            ) : (
              <div className="rounded-2xl border border-stone-200 bg-white/70 px-4 py-3 text-center text-sm text-stone-500">
                当前未开放自助注册，请使用已有账号登录。
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
