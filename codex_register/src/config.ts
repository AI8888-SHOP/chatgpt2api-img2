import {readFileSync} from "node:fs";
import path from "node:path";

export type MailProviderName =
    | "gmail"
    | "hotmail"
    | "cloudflare"
    | "cloudflare_temp_email"
    | "tempmail_lol"
    | "duckmail"
    | "gptmail"
    | "moemail"
    | "yyds_mail";

export interface LegacyMailProviderConfig {
    type?: unknown;
    enable?: unknown;
    api_base?: unknown;
    api_key?: unknown;
    admin_password?: unknown;
    domain?: unknown;
    default_domain?: unknown;
    subdomain?: unknown;
    wildcard?: unknown;
    expiry_time?: unknown;
}

export interface LegacyMailConfig {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    user_agent: string;
    providers: LegacyMailProviderConfig[];
}

interface AppConfigFile {
    provider?: unknown;
    defaultPassword?: unknown;
    loopDelayMs?: unknown;
    gmailAccessToken?: unknown;
    gmailEmailAddress?: unknown;
    cloudflareEmailDomain?: unknown;
    cloudflareApiBaseUrl?: unknown;
    cloudflareApiKey?: unknown;
    defaultProxyUrl?: unknown;
    cliproxyApiAutoUploadAuth?: unknown;
    cliproxyApiBaseUrl?: unknown;
    cliproxyApiManagementKey?: unknown;
    mail?: unknown;
}

export interface AppConfig {
    provider: MailProviderName;
    defaultPassword: string;
    loopDelayMs: number;
    gmailAccessToken: string;
    gmailEmailAddress: string;
    cloudflareEmailDomain: string;
    cloudflareApiBaseUrl: string;
    cloudflareApiKey: string;
    defaultProxyUrl: string;
    cliproxyApiAutoUploadAuth: boolean;
    cliproxyApiBaseUrl: string;
    cliproxyApiManagementKey: string;
    mail: LegacyMailConfig;
}

const DEFAULT_CONFIG: AppConfig = {
    provider: "cloudflare",
    defaultPassword: "kuaileshifu88",
    loopDelayMs: 120000,
    gmailAccessToken: "",
    gmailEmailAddress: "",
    cloudflareEmailDomain: "",
    cloudflareApiBaseUrl: "",
    cloudflareApiKey: "",
    defaultProxyUrl: "http://127.0.0.1:10808",
    cliproxyApiAutoUploadAuth: false,
    cliproxyApiBaseUrl: "http://localhost:8317",
    cliproxyApiManagementKey: "",
    mail: {
        request_timeout: 30,
        wait_timeout: 30,
        wait_interval: 2,
        user_agent: "Mozilla/5.0",
        providers: [],
    },
};

function normalizeNumber(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value;
}

function normalizeString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item ?? "").trim()).filter(Boolean);
    }
    const single = normalizeString(value);
    return single ? [single] : [];
}

function normalizeProvider(value: unknown): MailProviderName {
    if (
        value === "gmail" ||
        value === "hotmail" ||
        value === "cloudflare" ||
        value === "cloudflare_temp_email" ||
        value === "tempmail_lol" ||
        value === "duckmail" ||
        value === "gptmail" ||
        value === "moemail" ||
        value === "yyds_mail"
    ) {
        return value;
    }
    return DEFAULT_CONFIG.provider;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["false", "0", "no", "off"].includes(normalized)) {
            return false;
        }
    }
    return fallback;
}

function normalizeMailConfig(value: unknown): LegacyMailConfig {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];
    return {
        request_timeout: normalizeNumber(raw.request_timeout, DEFAULT_CONFIG.mail.request_timeout),
        wait_timeout: normalizeNumber(raw.wait_timeout, DEFAULT_CONFIG.mail.wait_timeout),
        wait_interval: normalizeNumber(raw.wait_interval, DEFAULT_CONFIG.mail.wait_interval),
        user_agent: normalizeString(raw.user_agent, DEFAULT_CONFIG.mail.user_agent),
        providers: rawProviders
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            .map((item) => ({
                ...item,
                type: normalizeString(item.type),
                enable: normalizeBoolean(item.enable, false),
                api_base: normalizeString(item.api_base),
                api_key: normalizeString(item.api_key),
                admin_password: normalizeString(item.admin_password),
                domain: normalizeStringArray(item.domain),
                default_domain: normalizeString(item.default_domain),
                subdomain: normalizeString(item.subdomain),
                wildcard: normalizeBoolean(item.wildcard, false),
                expiry_time: normalizeNumber(item.expiry_time, 0),
            })),
    };
}

function loadConfig(): AppConfig {
    const configPath = path.resolve(process.cwd(), "config.json");
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch {
        throw new Error("未找到 config.json，请先复制 config.example.json 为 config.json 并按需修改配置");
    }

    const parsed = JSON.parse(raw) as AppConfigFile;
    return {
        provider: normalizeProvider(parsed.provider),
        defaultPassword:
            typeof parsed.defaultPassword === "string" && parsed.defaultPassword.trim()
                ? parsed.defaultPassword
                : DEFAULT_CONFIG.defaultPassword,
        loopDelayMs: normalizeNumber(parsed.loopDelayMs, DEFAULT_CONFIG.loopDelayMs),
        gmailAccessToken:
            typeof parsed.gmailAccessToken === "string"
                ? parsed.gmailAccessToken.trim()
                : DEFAULT_CONFIG.gmailAccessToken,
        gmailEmailAddress:
            typeof parsed.gmailEmailAddress === "string"
                ? parsed.gmailEmailAddress.trim()
                : DEFAULT_CONFIG.gmailEmailAddress,
        cloudflareEmailDomain:
            typeof parsed.cloudflareEmailDomain === "string" && parsed.cloudflareEmailDomain.trim()
                ? parsed.cloudflareEmailDomain.trim()
                : DEFAULT_CONFIG.cloudflareEmailDomain,
        cloudflareApiBaseUrl:
            typeof parsed.cloudflareApiBaseUrl === "string"
                ? parsed.cloudflareApiBaseUrl.trim()
                : DEFAULT_CONFIG.cloudflareApiBaseUrl,
        cloudflareApiKey:
            typeof parsed.cloudflareApiKey === "string"
                ? parsed.cloudflareApiKey.trim()
                : DEFAULT_CONFIG.cloudflareApiKey,
        defaultProxyUrl:
            typeof parsed.defaultProxyUrl === "string"
                ? parsed.defaultProxyUrl.trim()
                : DEFAULT_CONFIG.defaultProxyUrl,
        cliproxyApiAutoUploadAuth: normalizeBoolean(
            parsed.cliproxyApiAutoUploadAuth,
            DEFAULT_CONFIG.cliproxyApiAutoUploadAuth,
        ),
        cliproxyApiBaseUrl:
            typeof parsed.cliproxyApiBaseUrl === "string" && parsed.cliproxyApiBaseUrl.trim()
                ? parsed.cliproxyApiBaseUrl.trim()
                : DEFAULT_CONFIG.cliproxyApiBaseUrl,
        cliproxyApiManagementKey:
            typeof parsed.cliproxyApiManagementKey === "string"
                ? parsed.cliproxyApiManagementKey.trim()
                : DEFAULT_CONFIG.cliproxyApiManagementKey,
        mail: normalizeMailConfig(parsed.mail),
    };
}

export const appConfig = loadConfig();
