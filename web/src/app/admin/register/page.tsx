"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle, Play, Plus, RotateCcw, Save, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import webConfig from "@/constants/common-env";
import {
  createRegisterEventsToken,
  fetchGptFreeRegisterConfig,
  fetchNewRegisterConfig,
  fetchRegisterConfig,
  resetOutlookPool,
  resetNewRegister,
  resetGptFreeRegister,
  resetRegister,
  startNewRegister,
  startGptFreeRegister,
  startRegister,
  stopNewRegister,
  stopGptFreeRegister,
  stopRegister,
  updateRegisterConfig,
  type RegisterConfig,
  type RegisterMailProvider,
} from "@/lib/api";

const providerTypes = [
  "cloudmail_gen",
  "cloudflare_temp_email",
  "tempmail_lol",
  "moemail",
  "inbucket",
  "duckmail",
  "gptmail",
  "yyds_mail",
  "ddg_mail",
  "outlook_token",
] as const;

function defaultProvider(): RegisterMailProvider {
  return {
    enable: true,
    type: "cloudmail_gen",
    api_base: "",
    admin_email: "",
    admin_password: "",
    domain: [],
    subdomain: [],
    email_prefix: "",
  };
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asTextList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
  return String(value || "");
}

function parseTextList(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item || "").split(/[\r\n,，;；]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function registerConfigPayload(config: RegisterConfig): Partial<RegisterConfig> {
  return {
    mail: {
      ...config.mail,
      providers: (config.mail.providers || []).map((provider) => ({
        ...provider,
        domain: parseTextList(provider.domain),
        ...(provider.subdomain_levels !== undefined
          ? { subdomain_levels: parseTextList(provider.subdomain_levels) }
          : {}),
      })),
    },
    proxy: config.proxy,
    total: config.total,
    threads: config.threads,
    mode: config.mode,
    target_quota: config.target_quota,
    target_available: config.target_available,
    check_interval: config.check_interval,
    auto_register_enabled: config.auto_register_enabled,
    auto_register_min_quota: config.auto_register_min_quota,
    engine: config.engine,
    codex: config.codex,
    default_password: config.default_password,
  };
}

export default function AdminRegisterPage() {
  const [config, setConfig] = useState<RegisterConfig | null>(null);
  const [newConfig, setNewConfig] = useState<RegisterConfig | null>(null);
  const [gptFreeConfig, setGptFreeConfig] = useState<RegisterConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchRegisterConfig();
      setConfig(data.register);
      try {
        const newData = await fetchNewRegisterConfig();
        setNewConfig(newData.register);
      } catch {
        // Older containers may not expose the optional reference engine yet.
      }
      try {
        const gptFreeData = await fetchGptFreeRegisterConfig();
        setGptFreeConfig(gptFreeData.register);
      } catch {
        // Older containers may not expose the optional gptFree engine yet.
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载注册机配置失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const { token } = await createRegisterEventsToken();
        if (closed || !token) return;
        const eventsUrl = new URL(`${webConfig.apiUrl.replace(/\/$/, "")}/api/register/new/events`);
        eventsUrl.searchParams.set("token", token);
        source = new EventSource(eventsUrl.toString(), { withCredentials: true });
        source.onmessage = (event) => {
          try {
            setNewConfig(JSON.parse(event.data) as RegisterConfig);
          } catch {
            // Ignore non-data keep-alive frames.
          }
        };
        source.onerror = () => {
          source?.close();
          source = null;
          if (!closed) reconnectTimer = setTimeout(() => void connect(), 1000);
        };
      } catch {
        if (!closed) reconnectTimer = setTimeout(() => void connect(), 2000);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const { token } = await createRegisterEventsToken();
        if (closed || !token) return;
        const eventsUrl = new URL(`${webConfig.apiUrl.replace(/\/$/, "")}/api/register/gptfree/events`);
        eventsUrl.searchParams.set("token", token);
        source = new EventSource(eventsUrl.toString(), { withCredentials: true });
        source.onmessage = (event) => {
          try {
            setGptFreeConfig(JSON.parse(event.data) as RegisterConfig);
          } catch {
            // Ignore non-data keep-alive frames.
          }
        };
        source.onerror = () => {
          source?.close();
          source = null;
          if (!closed) reconnectTimer = setTimeout(() => void connect(), 1000);
        };
      } catch {
        if (!closed) reconnectTimer = setTimeout(() => void connect(), 2000);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const { token } = await createRegisterEventsToken();
        if (closed || !token) return;
        const eventsUrl = new URL(`${webConfig.apiUrl.replace(/\/$/, "")}/api/register/events`);
        eventsUrl.searchParams.set("token", token);
        source = new EventSource(eventsUrl.toString(), { withCredentials: true });
        source.onmessage = (event) => {
          try {
            setConfig(JSON.parse(event.data) as RegisterConfig);
          } catch {
            // Ignore non-data keep-alive frames.
          }
        };
        source.onerror = () => {
          source?.close();
          source = null;
          if (!closed) reconnectTimer = setTimeout(() => void connect(), 1000);
        };
      } catch {
        if (!closed) reconnectTimer = setTimeout(() => void connect(), 2000);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  const stats = (config?.stats || {}) as Record<string, unknown>;
  const logs = (config?.logs || []) as Array<Record<string, unknown>>;
  const providers = useMemo(() => config?.mail?.providers || [], [config]);

  const updateLocal = (updates: Partial<RegisterConfig>) => {
    setConfig((current) => (current ? { ...current, ...updates } : current));
  };

  const updateMail = (updates: Record<string, unknown>) => {
    setConfig((current) => (current ? { ...current, mail: { ...(current.mail || {}), ...updates } } : current));
  };

  const updateProvider = (index: number, updates: RegisterMailProvider) => {
    setConfig((current) => {
      if (!current) return current;
      const nextProviders = [...(current.mail.providers || [])];
      nextProviders[index] = { ...nextProviders[index], ...updates };
      return { ...current, mail: { ...current.mail, providers: nextProviders } };
    });
  };

  const addProvider = () => {
    setConfig((current) => {
      if (!current) return current;
      return {
        ...current,
        mail: {
          ...current.mail,
          providers: [...(current.mail.providers || []), defaultProvider()],
        },
      };
    });
  };

  const deleteProvider = (index: number) => {
    setConfig((current) => {
      if (!current) return current;
      return {
        ...current,
        mail: {
          ...current.mail,
          providers: (current.mail.providers || []).filter((_, itemIndex) => itemIndex !== index),
        },
      };
    });
  };

  const save = async () => {
    if (!config) return;
    setIsSaving(true);
    try {
      const data = await updateRegisterConfig({
        ...registerConfigPayload(config),
        enabled: config.enabled,
      });
      setConfig(data.register);
      toast.success("注册机配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  };

  const runAction = async (action: "start" | "stop" | "reset") => {
    if (!config) return;
    setIsSaving(true);
    try {
      const data =
        action === "start"
          ? await startRegister(registerConfigPayload(config))
          : action === "stop"
            ? await stopRegister()
            : await resetRegister();
      setConfig(data.register);
      toast.success(action === "start" ? "注册机已启动" : action === "stop" ? "已请求停止" : "统计/日志已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsSaving(false);
    }
  };

  const runOutlookReset = async (scope: "all" | "failed" | "unused") => {
    setIsSaving(true);
    try {
      const data = await resetOutlookPool(scope);
      setConfig(data.register);
      toast.success(scope === "unused" ? "已清空未使用 Outlook 邮箱" : scope === "failed" ? "已重置失败/占用邮箱" : "已重置全部 Outlook 状态");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Outlook 池操作失败");
    } finally {
      setIsSaving(false);
    }
  };

  const runNewAction = async (action: "start" | "stop" | "reset") => {
    if (!config) return;
    setIsSaving(true);
    try {
      const data =
        action === "start"
          ? await startNewRegister(registerConfigPayload(config))
          : action === "stop"
            ? await stopNewRegister()
            : await resetNewRegister();
      setNewConfig(data.register);
      toast.success(action === "start" ? "新注册已启动" : action === "stop" ? "新注册已请求停止" : "新注册统计/日志已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新注册操作失败");
    } finally {
      setIsSaving(false);
    }
  };

  const runGptFreeAction = async (action: "start" | "stop" | "reset") => {
    if (!config) return;
    setIsSaving(true);
    try {
      const data =
        action === "start"
          ? await startGptFreeRegister(registerConfigPayload(config))
          : action === "stop"
            ? await stopGptFreeRegister()
            : await resetGptFreeRegister();
      setGptFreeConfig(data.register);
      toast.success(action === "start" ? "gptFree 注册已启动" : action === "stop" ? "gptFree 注册已请求停止" : "gptFree 统计/日志已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "gptFree 注册操作失败");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-8 text-sm text-stone-500">注册机配置加载失败</div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Register</div>
          <h1 className="text-2xl font-semibold tracking-tight">ChatGPT注册机（V141完整移植）</h1>
          <p className="text-sm text-stone-500">仅替换注册机核心与邮箱 Provider，账号入库仍写入本机 3020 号池。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void save()} disabled={isSaving}>
            <Save className="size-4" /> 保存
          </Button>
          {config.enabled ? (
            <Button variant="destructive" onClick={() => void runAction("stop")} disabled={isSaving}>
              <Square className="size-4" /> 停止
            </Button>
          ) : (
            <Button onClick={() => void runAction("start")} disabled={isSaving}>
              <Play className="size-4" /> 启动
            </Button>
          )}
          <Button variant="outline" onClick={() => void runAction("reset")} disabled={isSaving || config.enabled}>
            <RotateCcw className="size-4" /> 重置统计
          </Button>
        </div>
      </section>

      <section className="grid gap-4 rounded-xl border border-stone-200 bg-white/90 p-4 lg:grid-cols-4">
        <div className="space-y-2">
          <label className="text-sm text-stone-700">注册代理（可空）</label>
          <Input
            value={String(config.proxy || "")}
            onChange={(event) => updateLocal({ proxy: event.target.value })}
            disabled={config.enabled}
            placeholder="http://user:pass@host:port 或 socks5://..."
            className="h-10 rounded-xl"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm text-stone-700">模式</label>
          <Select value={String(config.mode || "total")} onValueChange={(value) => updateLocal({ mode: value })} disabled={isSaving}>
            <SelectTrigger className="h-10 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="total">注册总数</SelectItem>
              <SelectItem value="quota">号池剩余额度</SelectItem>
              <SelectItem value="available">可用账号数量</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm text-stone-700">总数 / 目标额度 / 目标可用</label>
          <div className="grid grid-cols-3 gap-2">
            <Input value={String(config.total ?? 0)} onChange={(event) => updateLocal({ total: numberValue(event.target.value, 0) })} disabled={isSaving} className="h-10 rounded-xl" />
            <Input value={String(config.target_quota ?? 0)} onChange={(event) => updateLocal({ target_quota: numberValue(event.target.value, 0) })} disabled={isSaving} className="h-10 rounded-xl" />
            <Input value={String(config.target_available ?? 0)} onChange={(event) => updateLocal({ target_available: numberValue(event.target.value, 0) })} disabled={isSaving} className="h-10 rounded-xl" />
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm text-stone-700">线程数 / 检查间隔(秒)</label>
          <div className="grid grid-cols-2 gap-2">
            <Input value={String(config.threads ?? 1)} onChange={(event) => updateLocal({ threads: numberValue(event.target.value, 1) })} disabled={config.enabled} className="h-10 rounded-xl" />
            <Input value={String(config.check_interval ?? 5)} onChange={(event) => updateLocal({ check_interval: numberValue(event.target.value, 5) })} disabled={config.enabled} className="h-10 rounded-xl" />
          </div>
        </div>
      </section>

      <section className="grid gap-4 rounded-xl border border-stone-200 bg-white/90 p-4 lg:grid-cols-4">
        <div className="space-y-2">
          <label className="text-sm text-stone-700">邮件请求超时(s)</label>
          <Input value={String(config.mail?.request_timeout ?? 30)} onChange={(event) => updateMail({ request_timeout: numberValue(event.target.value, 30) })} disabled={config.enabled} className="h-10 rounded-xl" />
        </div>
        <div className="space-y-2">
          <label className="text-sm text-stone-700">验证码等待超时(s)</label>
          <Input value={String(config.mail?.wait_timeout ?? 30)} onChange={(event) => updateMail({ wait_timeout: numberValue(event.target.value, 30) })} disabled={config.enabled} className="h-10 rounded-xl" />
        </div>
        <div className="space-y-2">
          <label className="text-sm text-stone-700">验证码轮询间隔(s)</label>
          <Input value={String(config.mail?.wait_interval ?? 2)} onChange={(event) => updateMail({ wait_interval: numberValue(event.target.value, 2) })} disabled={config.enabled} className="h-10 rounded-xl" />
        </div>
        <div className="flex items-end gap-2 pb-1">
          <Checkbox checked={Boolean(config.mail?.api_use_register_proxy)} onCheckedChange={(checked) => updateMail({ api_use_register_proxy: Boolean(checked) })} disabled={config.enabled} />
          <span className="text-sm text-stone-700">邮箱 API 使用注册代理</span>
        </div>
        <div className="flex items-end gap-2 pb-1 lg:col-span-2">
          <Checkbox checked={config.auto_register_enabled !== false && Boolean(config.auto_register_enabled)} onCheckedChange={(checked) => updateLocal({ auto_register_enabled: Boolean(checked) })} disabled={config.enabled} />
          <span className="text-sm text-stone-700">自动补号（额度不足时，使用新注册机）</span>
          <Input className="h-10 w-36 rounded-xl" value={String(config.auto_register_min_quota ?? 200)} onChange={(event) => updateLocal({ auto_register_min_quota: numberValue(event.target.value, 200) })} disabled={config.enabled || !config.auto_register_enabled} />
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-stone-200 bg-white/90 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">邮箱 Provider</h2>
            <p className="text-xs text-stone-500">完整移植 V141 Provider：cloudmail / cf temp mail / tempmail.lol / outlook_token 等</p>
          </div>
          <Button variant="outline" onClick={addProvider} disabled={config.enabled || isSaving}>
            <Plus className="size-4" /> 添加
          </Button>
        </div>

        <div className="space-y-4">
          {providers.map((provider, index) => {
            const type = String(provider.type || "cloudmail_gen");
            const domains = asTextList(provider.domain);
            const usesAdminPassword = type === "cloudmail_gen" || type === "cloudflare_temp_email";
            return (
              <div key={index} className="space-y-3 rounded-xl border border-stone-200 bg-stone-50/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Checkbox checked={provider.enable !== false} onCheckedChange={(checked) => updateProvider(index, { enable: Boolean(checked) })} disabled={config.enabled} />
                    <Select value={type} onValueChange={(value) => updateProvider(index, { type: value })} disabled={config.enabled}>
                      <SelectTrigger className="h-10 w-64 rounded-xl bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providerTypes.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Badge variant="secondary">#{index + 1}</Badge>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => deleteProvider(index)} disabled={config.enabled}>
                    <Trash2 className="size-4" /> 删除
                  </Button>
                </div>

                {type === "outlook_token" ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="space-y-2">
                        <label className="text-sm text-stone-700">取信模式</label>
                        <Select value={String(provider.mode || "graph")} onValueChange={(value) => updateProvider(index, { mode: value })} disabled={config.enabled}>
                          <SelectTrigger className="h-10 rounded-xl bg-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="graph">Graph API</SelectItem>
                            <SelectItem value="imap">IMAP (XOAUTH2)</SelectItem>
                            <SelectItem value="auto">自动 (Graph→IMAP)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {String(provider.mode || "graph") !== "graph" ? (
                        <div className="space-y-2 md:col-span-2">
                          <label className="text-sm text-stone-700">IMAP Host</label>
                          <Input value={String(provider.imap_host || "outlook.office365.com")} onChange={(event) => updateProvider(index, { imap_host: event.target.value })} disabled={config.enabled} className="h-10 rounded-xl bg-white" />
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm text-stone-700">邮箱池（邮箱----密码----client_id----refresh_token）</label>
                      <Textarea
                        value={String(provider.mailboxes || "")}
                        onChange={(event) => updateProvider(index, { mailboxes: event.target.value })}
                        placeholder={"每行一个邮箱，格式：\n邮箱----密码----client_id----refresh_token\n（已保存的敏感字段可能不会完整回显；此处用于新增或覆盖）"}
                        className="min-h-32 rounded-xl bg-white font-mono text-xs"
                        disabled={config.enabled}
                      />
                      <div className="flex flex-wrap gap-2 text-xs text-stone-500">
                        <span>已保存: {Number(provider.mailboxes_count || 0)}</span>
                        {provider.mailboxes_stats ? (
                          <span>状态: {JSON.stringify(provider.mailboxes_stats)}</span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" disabled={config.enabled || isSaving} onClick={() => void runOutlookReset("failed")}>重置失败/占用</Button>
                        <Button size="sm" variant="outline" disabled={config.enabled || isSaving} onClick={() => void runOutlookReset("unused")}>清空未使用</Button>
                        <Button size="sm" variant="outline" disabled={config.enabled || isSaving} onClick={() => void runOutlookReset("all")}>重置全部状态</Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm text-stone-700">API Base</label>
                      <Input value={String(provider.api_base || "")} onChange={(event) => updateProvider(index, { api_base: event.target.value })} disabled={config.enabled} className="h-10 rounded-xl bg-white" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm text-stone-700">API Key / Admin Password</label>
                      <Input
                        value={String(usesAdminPassword ? provider.admin_password || "" : provider.api_key || "")}
                        onChange={(event) =>
                          updateProvider(
                            index,
                            usesAdminPassword ? { admin_password: event.target.value } : { api_key: event.target.value },
                          )
                        }
                        disabled={config.enabled}
                        className="h-10 rounded-xl bg-white"
                      />
                    </div>
                    {type === "cloudmail_gen" ? (
                      <div className="space-y-2">
                        <label className="text-sm text-stone-700">Admin Email</label>
                        <Input value={String(provider.admin_email || "")} onChange={(event) => updateProvider(index, { admin_email: event.target.value })} disabled={config.enabled} className="h-10 rounded-xl bg-white" />
                      </div>
                    ) : null}
                    {type === "cloudflare_temp_email" ? (
                      <>
                        <div className="space-y-2 md:col-span-2">
                          <label className="text-sm text-stone-700">指定完整邮箱（可空）</label>
                          <Input
                            type="email"
                            value={String(provider.fixed_address || "")}
                            onChange={(event) => updateProvider(index, { fixed_address: event.target.value })}
                            placeholder="test@example.com"
                            disabled={config.enabled}
                            className="h-10 rounded-xl bg-white"
                          />
                          <p className="text-xs text-stone-500">填写后复用或精确创建该地址，请将线程数设为 1。</p>
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm text-stone-700">随机子域层数</label>
                          <Input
                            type="number"
                            min={1}
                            max={5}
                            value={String(provider.random_subdomain_depth ?? 1)}
                            onChange={(event) => updateProvider(index, { random_subdomain_depth: numberValue(event.target.value, 1) })}
                            disabled={config.enabled}
                            className="h-10 rounded-xl bg-white"
                          />
                        </div>
                        <div className="flex items-end gap-2 pb-2">
                          <Checkbox
                            checked={provider.append_random_suffix !== false}
                            onCheckedChange={(checked) => updateProvider(index, { append_random_suffix: Boolean(checked) })}
                            disabled={config.enabled}
                          />
                          <span className="text-sm text-stone-700">手动子域追加随机后缀</span>
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <label className="text-sm text-stone-700">手动子域层（每行一级，可空）</label>
                          <Textarea
                            value={asTextList(provider.subdomain_levels)}
                            onChange={(event) => updateProvider(index, { subdomain_levels: event.target.value })}
                            placeholder="例如：mail\nregister"
                            className="min-h-16 rounded-xl bg-white font-mono text-xs"
                            disabled={config.enabled}
                          />
                        </div>
                      </>
                    ) : null}
                    {type === "duckmail" ? (
                      <div className="space-y-2">
                        <label className="text-sm text-stone-700">Default Domain</label>
                        <Input value={String(provider.default_domain || "duckmail.sbs")} onChange={(event) => updateProvider(index, { default_domain: event.target.value })} disabled={config.enabled} className="h-10 rounded-xl bg-white" />
                      </div>
                    ) : null}
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm text-stone-700">Domain 列表</label>
                      <Textarea
                        value={domains}
                        onChange={(event) => updateProvider(index, { domain: event.target.value })}
                        placeholder={
                          type === "cloudflare_temp_email"
                            ? "每行一个根域名，例如：example.com"
                            : "每行一个域名，也可用逗号分隔"
                        }
                        className="min-h-20 rounded-xl bg-white font-mono text-xs"
                        disabled={config.enabled}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {providers.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-sm text-stone-500">
              <AlertTriangle className="size-4" /> 还没有邮箱 Provider，请先添加。
            </div>
          ) : null}
        </div>
      </section>

      {newConfig ? (
        <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-semibold">新注册（Reference 引擎）</h2>
              <p className="text-xs text-stone-500">按授权页落点自动选择密码注册或无密码 OTP，和旧注册机独立运行。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {newConfig.enabled ? (
                <Button variant="destructive" onClick={() => void runNewAction("stop")} disabled={isSaving}>
                  <Square className="size-4" /> 停止新注册
                </Button>
              ) : (
                <Button onClick={() => void runNewAction("start")} disabled={isSaving}>
                  <Play className="size-4" /> 启动新注册
                </Button>
              )}
              <Button variant="outline" onClick={() => void runNewAction("reset")} disabled={isSaving || newConfig.enabled}>
                <RotateCcw className="size-4" /> 重置新注册
              </Button>
            </div>
          </div>
          {(() => {
            const newStats = (newConfig.stats || {}) as Record<string, unknown>;
            const newLogs = (newConfig.logs || []) as Array<Record<string, unknown>>;
            return (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-amber-200 bg-white/80 p-3 text-sm">
                  <div>状态：{newConfig.enabled ? "运行中" : "已停止"}</div>
                  <div>成功：{String(newStats.success ?? 0)}</div>
                  <div>失败：{String(newStats.fail ?? 0)}</div>
                  <div>完成：{String(newStats.done ?? 0)}</div>
                  <div>运行线程：{String(newStats.running ?? 0)}</div>
                  <div>成功率：{String(newStats.success_rate ?? 0)}%</div>
                </div>
                <div className="h-48 touch-pan-y space-y-1 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-stone-950 p-3 font-mono text-xs text-stone-100">
                  {newLogs.length ? (
                    newLogs.slice(-120).reverse().map((item, index) => (
                      <div key={index} className="break-words">
                        <span className="text-stone-400">{String(item.time || "")}</span> {String(item.text || "")}
                      </div>
                    ))
                  ) : (
                    <div className="text-stone-500">暂无新注册日志</div>
                  )}
                </div>
              </div>
            );
          })()}
        </section>
      ) : null}

      {gptFreeConfig ? (
        <section className="space-y-3 rounded-xl border border-cyan-200 bg-cyan-50/50 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-semibold">gptFree 注册</h2>
              <p className="text-xs text-stone-500">注册 Agent Identity 账号并写入独立 gptFree 号池。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {gptFreeConfig.enabled ? (
                <Button variant="destructive" onClick={() => void runGptFreeAction("stop")} disabled={isSaving}>
                  <Square className="size-4" /> 停止 gptFree
                </Button>
              ) : (
                <Button onClick={() => void runGptFreeAction("start")} disabled={isSaving}>
                  <Play className="size-4" /> 启动 gptFree
                </Button>
              )}
              <Button variant="outline" onClick={() => void runGptFreeAction("reset")} disabled={isSaving || gptFreeConfig.enabled}>
                <RotateCcw className="size-4" /> 重置 gptFree
              </Button>
            </div>
          </div>
          {(() => {
            const gptFreeStats = (gptFreeConfig.stats || {}) as Record<string, unknown>;
            const gptFreeLogs = (gptFreeConfig.logs || []) as Array<Record<string, unknown>>;
            return (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-cyan-200 bg-white/80 p-3 text-sm">
                  <div>状态：{gptFreeConfig.enabled ? "运行中" : "已停止"}</div>
                  <div>成功：{String(gptFreeStats.success ?? 0)}</div>
                  <div>失败：{String(gptFreeStats.fail ?? 0)}</div>
                  <div>完成：{String(gptFreeStats.done ?? 0)}</div>
                  <div>运行线程：{String(gptFreeStats.running ?? 0)}</div>
                  <div>gptFree 可用：{String(gptFreeStats.current_available ?? 0)}</div>
                </div>
                <div className="h-56 touch-pan-y space-y-1 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-stone-950 p-3 font-mono text-xs text-stone-100">
                  {gptFreeLogs.length ? (
                    gptFreeLogs.slice(-160).reverse().map((item, index) => (
                      <div key={index} className="break-words">
                        <span className="text-stone-400">{String(item.time || "")}</span> {String(item.text || "")}
                      </div>
                    ))
                  ) : (
                    <div className="text-stone-500">暂无 gptFree 日志</div>
                  )}
                </div>
              </div>
            );
          })()}
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-stone-200 bg-white/90 p-4">
          <h2 className="mb-3 text-base font-semibold">运行状态</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>状态：{config.enabled ? "运行中" : "已停止"}</div>
            <div>成功：{String(stats.success ?? 0)}</div>
            <div>失败：{String(stats.fail ?? 0)}</div>
            <div>完成：{String(stats.done ?? 0)}</div>
            <div>运行线程：{String(stats.running ?? 0)}</div>
            <div>当前额度：{String(stats.current_quota ?? "-")}</div>
            <div>当前可用：{String(stats.current_available ?? "-")}</div>
            <div>成功率：{String(stats.success_rate ?? 0)}%</div>
          </div>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white/90 p-4">
          <h2 className="mb-3 text-base font-semibold">实时日志</h2>
          <div className="h-80 touch-pan-y space-y-1 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-stone-950 p-3 font-mono text-xs text-stone-100">
            {logs.length ? (
              logs.slice(-200).reverse().map((item, index) => (
                <div key={index} className="break-words">
                  <span className="text-stone-400">{String(item.time || "")}</span> {String(item.text || "")}
                </div>
              ))
            ) : (
              <div className="text-stone-500">暂无日志</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
