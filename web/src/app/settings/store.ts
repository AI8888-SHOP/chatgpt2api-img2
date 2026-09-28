"use client";

import { create } from "zustand";
import { toast } from "sonner";

import {
  createCPAPool,
  deleteCPAPool,
  fetchCPAPoolFiles,
  fetchCPAPools,
  fetchSettingsConfig,
  startCPAImport,
  updateCPAPool,
  updateSettingsConfig,
  type CPAPool,
  type CPARemoteFile,
  type ImageUpstreamConfig,
  type QuickPromptConfig,
  type SettingsConfig,
} from "@/lib/api";

export const PAGE_SIZE_OPTIONS = ["50", "100", "200"] as const;

export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  const rawUpstreams = Array.isArray(config.image_upstreams) ? config.image_upstreams : [];
  const rawQuickPrompts = Array.isArray(config.quick_prompts) ? config.quick_prompts : [];
  return {
    ...config,
    site_title: typeof config.site_title === "string" && config.site_title.trim() ? config.site_title.trim() : "image 专业绘图",
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    image_upstreams: rawUpstreams.map((item, index) => ({
      name: String(item.name || `上游 ${index + 1}`),
      base_url: String(item.base_url || ""),
      api_key: String(item.api_key || ""),
      model: String(item.model || "gpt-image-2"),
      enabled: item.enabled !== false,
    })),
    image_upstream_cooldown_secs: Math.max(0, Number(config.image_upstream_cooldown_secs ?? 600)),
    quick_prompts: rawQuickPrompts
      .map((item, index) => ({
        label: String(item.label || `快捷提示词 ${index + 1}`).trim(),
        content: String(item.content || "").trim(),
      }))
      .filter((item) => item.content),
    default_user_quota: Math.max(0, Number(config.default_user_quota || 0)),
    user_registration_enabled: config.user_registration_enabled !== false,
    invite_registration_enabled: config.invite_registration_enabled !== false,
    invite_inviter_quota: Math.max(0, Number(config.invite_inviter_quota ?? 10)),
    invite_invited_quota: Math.max(0, Number(config.invite_invited_quota ?? 10)),
    psd_task_price: Math.max(0, Number(config.psd_task_price ?? 1)),
    auto_remove_abnormal_accounts: config.auto_remove_abnormal_accounts === true,
    register_email_verification_enabled: config.register_email_verification_enabled === true,
    register_email_domain_whitelist: typeof config.register_email_domain_whitelist === "string" ? config.register_email_domain_whitelist : "",
    smtp_host: typeof config.smtp_host === "string" ? config.smtp_host : "",
    smtp_port: Math.max(0, Number(config.smtp_port || 587)),
    smtp_username: typeof config.smtp_username === "string" ? config.smtp_username : "",
    smtp_password: typeof config.smtp_password === "string" ? config.smtp_password : "",
    smtp_from_email: typeof config.smtp_from_email === "string" ? config.smtp_from_email : "",
    smtp_from_name: typeof config.smtp_from_name === "string" ? config.smtp_from_name : "",
    smtp_tls_enabled: config.smtp_tls_enabled !== false,
  };
}

function normalizeFiles(items: CPARemoteFile[]) {
  const seen = new Set<string>();
  const files: CPARemoteFile[] = [];
  for (const item of items) {
    const name = String(item.name || "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    files.push({
      name,
      email: String(item.email || "").trim(),
    });
  }
  return files;
}

type SettingsStore = {
  config: SettingsConfig | null;
  isLoadingConfig: boolean;
  isSavingConfig: boolean;

  pools: CPAPool[];
  isLoadingPools: boolean;
  deletingId: string | null;
  loadingFilesId: string | null;

  dialogOpen: boolean;
  editingPool: CPAPool | null;
  formName: string;
  formBaseUrl: string;
  formSecretKey: string;
  showSecret: boolean;
  isSavingPool: boolean;

  browserOpen: boolean;
  browserPool: CPAPool | null;
  remoteFiles: CPARemoteFile[];
  selectedNames: string[];
  fileQuery: string;
  filePage: number;
  pageSize: PageSizeOption;
  isStartingImport: boolean;

  initialize: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  setProxy: (value: string) => void;
  setDefaultUserQuota: (value: number) => void;
  setUserRegistrationEnabled: (value: boolean) => void;
  setAutoRemoveAbnormalAccounts: (value: boolean) => void;
  setConfigValue: (key: keyof SettingsConfig, value: SettingsConfig[keyof SettingsConfig]) => void;
  setImageUpstreams: (items: ImageUpstreamConfig[]) => void;
  setQuickPrompts: (items: QuickPromptConfig[]) => void;

  loadPools: (silent?: boolean) => Promise<void>;
  openAddDialog: () => void;
  openEditDialog: (pool: CPAPool) => void;
  setDialogOpen: (open: boolean) => void;
  setFormName: (value: string) => void;
  setFormBaseUrl: (value: string) => void;
  setFormSecretKey: (value: string) => void;
  setShowSecret: (checked: boolean) => void;
  savePool: () => Promise<void>;
  deletePool: (pool: CPAPool) => Promise<void>;

  browseFiles: (pool: CPAPool) => Promise<void>;
  setBrowserOpen: (open: boolean) => void;
  toggleFile: (name: string, checked: boolean) => void;
  replaceSelectedNames: (names: string[]) => void;
  setFileQuery: (value: string) => void;
  setFilePage: (page: number) => void;
  setPageSize: (value: PageSizeOption) => void;
  startImport: () => Promise<void>;
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  config: null,
  isLoadingConfig: true,
  isSavingConfig: false,

  pools: [],
  isLoadingPools: true,
  deletingId: null,
  loadingFilesId: null,

  dialogOpen: false,
  editingPool: null,
  formName: "",
  formBaseUrl: "",
  formSecretKey: "",
  showSecret: false,
  isSavingPool: false,

  browserOpen: false,
  browserPool: null,
  remoteFiles: [],
  selectedNames: [],
  fileQuery: "",
  filePage: 1,
  pageSize: "100",
  isStartingImport: false,

  initialize: async () => {
    await Promise.allSettled([get().loadConfig(), get().loadPools()]);
  },

  loadConfig: async () => {
    set({ isLoadingConfig: true });
    try {
      const data = await fetchSettingsConfig();
      set({
        config: normalizeConfig(data.config),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载系统配置失败");
    } finally {
      set({ isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) {
      return;
    }

    set({ isSavingConfig: true });
    try {
      const data = await updateSettingsConfig({
        ...config,
        site_title: String(config.site_title || "").trim() || "image 专业绘图",
        proxy: config.proxy.trim(),
        image_upstreams: (config.image_upstreams || []).map((item) => ({
          name: item.name.trim(),
          base_url: item.base_url.trim().replace(/\/+$/, ""),
          api_key: item.api_key.trim(),
          model: item.model.trim() || "gpt-image-2",
          enabled: item.enabled,
        })),
        quick_prompts: (config.quick_prompts || [])
          .map((item, index) => ({
            label: String(item.label || `快捷提示词 ${index + 1}`).trim(),
            content: String(item.content || "").trim(),
          }))
          .filter((item) => item.content),
      });
      set({
        config: normalizeConfig(data.config),
      });
      if (typeof window !== "undefined") {
        const siteTitle = String(data.config.site_title || "image 专业绘图").trim() || "image 专业绘图";
        document.title = siteTitle;
        document.documentElement.dataset.siteTitle = siteTitle;
        window.dispatchEvent(new CustomEvent("app:site-title", { detail: { siteTitle } }));
      }
      toast.success("配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存系统配置失败");
    } finally {
      set({ isSavingConfig: false });
    }
  },

  setProxy: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          proxy: value,
        },
      };
    });
  },

  setDefaultUserQuota: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          default_user_quota: Math.max(0, Number(value) || 0),
        },
      };
    });
  },

  setUserRegistrationEnabled: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          user_registration_enabled: value,
        },
      };
    });
  },

  setAutoRemoveAbnormalAccounts: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          auto_remove_abnormal_accounts: value,
        },
      };
    });
  },

  setConfigValue: (key, value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          [key]: value,
        },
      };
    });
  },

  setImageUpstreams: (items) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          image_upstreams: items,
        },
      };
    });
  },

  setQuickPrompts: (items) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          quick_prompts: items,
        },
      };
    });
  },

  loadPools: async (silent = false) => {
    if (!silent) {
      set({ isLoadingPools: true });
    }
    try {
      const data = await fetchCPAPools();
      set({ pools: data.pools });
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : "加载 CPA 连接失败");
      }
    } finally {
      if (!silent) {
        set({ isLoadingPools: false });
      }
    }
  },

  openAddDialog: () => {
    set({
      editingPool: null,
      formName: "",
      formBaseUrl: "",
      formSecretKey: "",
      showSecret: false,
      dialogOpen: true,
    });
  },

  openEditDialog: (pool) => {
    set({
      editingPool: pool,
      formName: pool.name,
      formBaseUrl: pool.base_url,
      formSecretKey: "",
      showSecret: false,
      dialogOpen: true,
    });
  },

  setDialogOpen: (open) => {
    set({ dialogOpen: open });
  },

  setFormName: (value) => {
    set({ formName: value });
  },

  setFormBaseUrl: (value) => {
    set({ formBaseUrl: value });
  },

  setFormSecretKey: (value) => {
    set({ formSecretKey: value });
  },

  setShowSecret: (checked) => {
    set({ showSecret: checked });
  },

  savePool: async () => {
    const { editingPool, formName, formBaseUrl, formSecretKey } = get();
    if (!formBaseUrl.trim()) {
      toast.error("请输入 CPA 地址");
      return;
    }
    if (!editingPool && !formSecretKey.trim()) {
      toast.error("请输入 Secret Key");
      return;
    }

    set({ isSavingPool: true });
    try {
      if (editingPool) {
        const data = await updateCPAPool(editingPool.id, {
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          secret_key: formSecretKey.trim() || undefined,
        });
        set({ pools: data.pools, dialogOpen: false });
        toast.success("连接已更新");
      } else {
        const data = await createCPAPool({
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          secret_key: formSecretKey.trim(),
        });
        set({ pools: data.pools, dialogOpen: false });
        toast.success("连接已添加");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      set({ isSavingPool: false });
    }
  },

  deletePool: async (pool) => {
    set({ deletingId: pool.id });
    try {
      const data = await deleteCPAPool(pool.id);
      set({ pools: data.pools });
      toast.success("连接已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      set({ deletingId: null });
    }
  },

  browseFiles: async (pool) => {
    set({ loadingFilesId: pool.id });
    try {
      const data = await fetchCPAPoolFiles(pool.id);
      const files = normalizeFiles(data.files);
      set({
        browserPool: pool,
        remoteFiles: files,
        selectedNames: [],
        fileQuery: "",
        filePage: 1,
        browserOpen: true,
      });
      toast.success(`读取成功，共 ${files.length} 个远程账号`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取远程账号失败");
    } finally {
      set({ loadingFilesId: null });
    }
  },

  setBrowserOpen: (open) => {
    set({ browserOpen: open });
  },

  toggleFile: (name, checked) => {
    set((state) => {
      if (checked) {
        return {
          selectedNames: Array.from(new Set([...state.selectedNames, name])),
        };
      }
      return {
        selectedNames: state.selectedNames.filter((item) => item !== name),
      };
    });
  },

  replaceSelectedNames: (names) => {
    set({ selectedNames: Array.from(new Set(names)) });
  },

  setFileQuery: (value) => {
    set({ fileQuery: value, filePage: 1 });
  },

  setFilePage: (page) => {
    set({ filePage: page });
  },

  setPageSize: (value) => {
    set({ pageSize: value, filePage: 1 });
  },

  startImport: async () => {
    const { browserPool, selectedNames, pools } = get();
    if (!browserPool) {
      return;
    }
    if (selectedNames.length === 0) {
      toast.error("请先选择要导入的账号");
      return;
    }

    set({ isStartingImport: true });
    try {
      const result = await startCPAImport(browserPool.id, selectedNames);
      set({
        pools: pools.map((pool) =>
          pool.id === browserPool.id ? { ...pool, import_job: result.import_job } : pool,
        ),
        browserOpen: false,
      });
      toast.success("导入任务已启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动导入失败");
    } finally {
      set({ isStartingImport: false });
    }
  },
}));
