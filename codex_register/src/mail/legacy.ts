import {createHash} from "node:crypto";
import {appConfig, type LegacyMailProviderConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";

type Mailbox = Record<string, string>;
type LegacyMailMessage = {
    provider: string;
    mailbox: string;
    id?: string;
    sender?: string;
    recipient?: string | string[];
    subject?: string;
    content?: string;
    timestamp?: number;
    text_content?: string;
    html_content?: string;
};

type FetchJsonOptions = {
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    expected?: number[];
};

let providerIndex = 0;
let domainIndex = 0;

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message: string): void {
    console.log(`[legacy-mail] ${message}`);
}

function clean(value: unknown): string {
    return String(value ?? "").trim();
}

function enabledProviders(): LegacyMailProviderConfig[] {
    const providers = appConfig.mail.providers.filter((item) => item.enable && clean(item.type));
    if (!providers.length) {
        throw new Error("mail.providers 没有启用的 provider");
    }
    return providers;
}

function nextProvider(): LegacyMailProviderConfig {
    const providers = enabledProviders();
    if (providers.length === 1) {
        return providers[0];
    }
    const provider = providers[providerIndex % providers.length];
    providerIndex = (providerIndex + 1) % providers.length;
    return provider;
}

function providerByMailbox(mailbox: Mailbox): LegacyMailProviderConfig {
    const providerRef = clean(mailbox.provider_ref);
    if (providerRef) {
        const [type, rawIndex] = providerRef.split("#");
        const index = Number.parseInt(rawIndex ?? "", 10) - 1;
        const providers = appConfig.mail.providers.filter((item) => clean(item.type) === type);
        if (index >= 0 && providers[index]) {
            return providers[index];
        }
    }
    const provider = enabledProviders().find((item) => clean(item.type) === clean(mailbox.provider));
    if (!provider) {
        throw new Error(`不支持的 mail.provider: ${mailbox.provider}`);
    }
    return provider;
}

function providerRef(provider: LegacyMailProviderConfig): string {
    const type = clean(provider.type);
    const sameType = appConfig.mail.providers.filter((item) => clean(item.type) === type);
    const index = sameType.indexOf(provider);
    return `${type}#${Math.max(1, index + 1)}`;
}

function domains(provider: LegacyMailProviderConfig): string[] {
    return Array.isArray(provider.domain)
        ? provider.domain.map((item) => clean(item)).filter(Boolean)
        : [];
}

function nextDomain(provider: LegacyMailProviderConfig, fallback = ""): string {
    const items = domains(provider);
    if (!items.length) {
        if (fallback) {
            return fallback;
        }
        throw new Error("mail.domain 不能为空");
    }
    if (items.length === 1) {
        return items[0];
    }
    const value = items[domainIndex % items.length];
    domainIndex = (domainIndex + 1) % items.length;
    return value;
}

function resolveTempMailDomain(value: string): {domain: string; forceRandomPrefix: boolean} {
    const domain = clean(value).toLowerCase();
    if (domain.startsWith("*.") && domain.length > 2) {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        const length = 4 + Math.floor(Math.random() * 7);
        let subdomain = "";
        for (let index = 0; index < length; index += 1) {
            subdomain += chars[Math.floor(Math.random() * chars.length)];
        }
        return {domain: `${subdomain}.${domain.slice(2)}`, forceRandomPrefix: true};
    }
    return {domain, forceRandomPrefix: false};
}

function parseTimestamp(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 10_000_000_000 ? value * 1000 : value;
    }
    const parsed = Date.parse(clean(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

function latestTimestamp(value: Record<string, unknown>): number {
    return parseTimestamp(
        value.createdAt ?? value.created_at ?? value.receivedAt ?? value.received_at ?? value.date ?? value.timestamp,
    );
}

function contentOf(item: Record<string, unknown>): string {
    const text = clean(item.text_content) || clean(item.text) || clean(item.body) || clean(item.content);
    const html = clean(item.html_content) || clean(item.html) || clean(item.html_body) || clean(item.body_html);
    return [text, html].filter(Boolean).join("\n");
}

function extractTextCandidates(value: unknown): string[] {
    if (typeof value === "string") {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => extractTextCandidates(item));
    }
    if (value && typeof value === "object") {
        const raw = value as Record<string, unknown>;
        const output: string[] = [];
        for (const key of ["address", "email", "name", "value"]) {
            output.push(...extractTextCandidates(raw[key]));
        }
        return output;
    }
    return [];
}

function messageMatchesEmail(item: Record<string, unknown>, email: string): boolean {
    const target = clean(email).toLowerCase();
    const candidates: string[] = [];
    for (const key of ["to", "mailTo", "receiver", "receivers", "address", "email", "envelope_to"]) {
        if (key in item) {
            candidates.push(...extractTextCandidates(item[key]));
        }
    }
    return !target || candidates.length === 0 || candidates.some((entry) => clean(entry).toLowerCase().includes(target));
}

function senderOf(item: Record<string, unknown>): string {
    const sender = item.from ?? item.sender ?? item.from_address;
    if (sender && typeof sender === "object") {
        const raw = sender as Record<string, unknown>;
        return clean(raw.address) || clean(raw.email) || clean(raw.name);
    }
    return clean(sender);
}

function normalizeMessage(
    provider: string,
    item: Record<string, unknown>,
    mailbox: Mailbox,
    overrides: Partial<LegacyMailMessage> = {},
): LegacyMailMessage {
    const sender = senderOf(item);
    const textContent = clean(overrides.text_content) || clean(item.text_content) || clean(item.text) || clean(item.body) || clean(item.content);
    const htmlRaw = overrides.html_content ?? item.html_content ?? item.html ?? item.html_body ?? item.body_html;
    const htmlContent = Array.isArray(htmlRaw) ? htmlRaw.map((value) => clean(value)).filter(Boolean).join("") : clean(htmlRaw);
    const id = clean(overrides.id) || clean(item.id) || clean(item._id) || clean(item.message_id) || clean(item.token);
    const recipient = clean(item.to) || clean(item.mailTo) || clean(item.receiver) || clean(item.address) || clean(item.email) || mailbox.address;
    const subject = clean(item.subject);
    const content = [textContent, htmlContent].filter(Boolean).join("\n") || contentOf(item);
    const timestamp = overrides.timestamp ?? latestTimestamp(item);
    return {
        provider,
        mailbox: mailbox.address,
        id,
        sender,
        recipient,
        subject,
        content,
        timestamp,
        text_content: textContent,
        html_content: htmlContent,
        ...overrides,
    };
}

function messageTrackingRef(message: LegacyMailMessage): string {
    const id = clean(message.id);
    if (id) {
        return `id:${message.provider}:${message.mailbox}:${id}`;
    }
    const timestamp = Number(message.timestamp ?? 0) || 0;
    const content = [message.subject, message.sender, message.text_content, message.html_content, message.content]
        .map((item) => clean(item))
        .filter(Boolean)
        .join("\n");
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    return `content:${message.provider}:${message.mailbox}:${timestamp}:${digest}`;
}

function extractCode(message: LegacyMailMessage): string {
    const content = `${clean(message.subject)}\n${clean(message.text_content)}\n${clean(message.html_content)}`.trim();
    if (!content) {
        return "";
    }
    const htmlMatch = content.match(/background-color:\s*#F3F3F3[^>]*>[\s\S]*?(\d{6})[\s\S]*?<\/p>/i);
    if (htmlMatch?.[1]) {
        return htmlMatch[1];
    }
    const labelledMatch = content.match(/(?:Verification code|code is|代码为|验证码)[:\s]*(\d{6})/i);
    if (labelledMatch?.[1] && labelledMatch[1] !== "177010") {
        return labelledMatch[1];
    }
    const allMatches = [...content.matchAll(/>\s*(\d{6})\s*<|(?<![#&])\b(\d{6})\b/g)];
    for (const match of allMatches) {
        const value = match[1] || match[2] || "";
        if (value && value !== "177010") {
            return value;
        }
    }
    return "";
}

function apiUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>): URL {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value != null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }
    return url;
}

async function fetchJson(baseUrl: string, path: string, options: FetchJsonOptions = {}) {
    const expected = options.expected ?? [200];
    const response = await fetch(apiUrl(baseUrl, path, options.query), {
        method: options.method ?? "GET",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": appConfig.mail.user_agent,
            ...(options.headers ?? {}),
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
    });
    const raw = response.status === 204 ? "" : await response.text();
    if (!expected.includes(response.status)) {
        throw new Error(`${baseUrl}${path} 请求失败: HTTP ${response.status}, body=${raw.slice(0, 300)}`);
    }
    if (!raw) {
        return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

async function pollVerificationCode(mailbox: Mailbox, loader: () => Promise<LegacyMailMessage | null>): Promise<string> {
    const attempts = Math.max(1, Math.ceil(appConfig.mail.wait_timeout / Math.max(1, appConfig.mail.wait_interval)));
    const intervalMs = Math.max(1, appConfig.mail.wait_interval) * 1000;
    const seenValue = mailbox._seen_code_message_refs
        ? mailbox._seen_code_message_refs.split("\n").map((item) => clean(item)).filter(Boolean)
        : [];
    const seenRefs = new Set(seenValue);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const current = await loader();
        const trackingRef = current ? messageTrackingRef(current) : "";
        if (current) {
            debugLog(
                `poll attempt=${attempt}/${attempts} provider=${current.provider} email=${mailbox.address} id=${clean(current.id)} subject=${JSON.stringify((current.subject ?? "").slice(0, 120))} sender=${JSON.stringify((current.sender ?? "").slice(0, 120))} content=${JSON.stringify((current.content ?? "").slice(0, 200))}`,
            );
        } else {
            debugLog(`poll attempt=${attempt}/${attempts} provider=${clean(mailbox.provider)} email=${mailbox.address} message=null`);
        }
        if (current && trackingRef && !seenRefs.has(trackingRef)) {
            const code = extractCode(current);
            if (code) {
                debugLog(`poll matched provider=${clean(mailbox.provider)} email=${mailbox.address} code=${code}`);
                seenRefs.add(trackingRef);
                mailbox._seen_code_message_refs = [...seenRefs].join("\n");
                return code;
            }
        }
        if (attempt < attempts) {
            await wait(intervalMs);
        }
    }
    throw new Error(`邮箱中未找到验证码: targetEmail=${mailbox.address}`);
}

async function createCloudflareTempMailbox(provider: LegacyMailProviderConfig): Promise<Mailbox> {
    const data = await fetchJson(clean(provider.api_base), "/admin/new_address", {
        method: "POST",
        headers: {"x-admin-auth": clean(provider.admin_password)},
        body: {
            enablePrefix: true,
            name: generateEmailName(),
            domain: nextDomain(provider),
        },
    }) as Record<string, unknown>;
    const address = clean(data.address);
    const token = clean(data.jwt);
    if (!address || !token) {
        throw new Error("CloudflareTempMail 缺少 address 或 jwt");
    }
    return {provider: "cloudflare_temp_email", provider_ref: providerRef(provider), address, token};
}

async function fetchCloudflareTempMessage(provider: LegacyMailProviderConfig, mailbox: Mailbox): Promise<LegacyMailMessage | null> {
    const data = await fetchJson(clean(provider.api_base), "/api/mails", {
        headers: {Authorization: `Bearer ${mailbox.token}`},
        query: {limit: 10, offset: 0},
    });
    const raw = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
    const messages = raw
        .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .filter((item) => messageMatchesEmail(item, mailbox.address));
    if (!messages.length) {
        return null;
    }
    return normalizeMessage("cloudflare_temp_email", messages[0], mailbox);
}

async function createTempMailLolMailbox(provider: LegacyMailProviderConfig): Promise<Mailbox> {
    const body: Record<string, string> = {};
    const domainList = domains(provider);
    if (domainList.length) {
        const selected = resolveTempMailDomain(domainList[Math.floor(Math.random() * domainList.length)]);
        body.domain = selected.domain;
        if (selected.forceRandomPrefix) {
            body.prefix = generateEmailName();
        }
    }
    if (!body.prefix) {
        body.prefix = generateEmailName();
    }
    const headers: Record<string, string> = {};
    const apiKey = clean(provider.api_key);
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    const data = await fetchJson("https://api.tempmail.lol/v2", "/inbox/create", {
        method: "POST",
        headers,
        body,
        expected: [200, 201],
    }) as Record<string, unknown>;
    const address = clean(data.address);
    const token = clean(data.token);
    if (!address || !token) {
        throw new Error("TempMail.lol 缺少 address 或 token");
    }
    return {provider: "tempmail_lol", provider_ref: providerRef(provider), address, token};
}

async function fetchTempMailLolMessage(mailbox: Mailbox): Promise<LegacyMailMessage | null> {
    const data = await fetchJson("https://api.tempmail.lol/v2", "/inbox", {
        query: {token: mailbox.token},
    });
    const raw = Array.isArray(data?.emails) ? data.emails : Array.isArray(data?.messages) ? data.messages : [];
    const messages = raw.filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    if (!messages.length) {
        return null;
    }
    const latest = messages.reduce((best, current) => {
        const currentKey = [latestTimestamp(current), clean(current.id) || clean(current.token)];
        const bestKey = [latestTimestamp(best), clean(best.id) || clean(best.token)];
        return currentKey[0] > bestKey[0] || (currentKey[0] === bestKey[0] && currentKey[1] > bestKey[1]) ? current : best;
    });
    return normalizeMessage("tempmail_lol", latest, mailbox);
}

function duckItems(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
        return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
    if (data && typeof data === "object") {
        const raw = data as Record<string, unknown>;
        const items = raw["hydra:member"] ?? raw.member ?? raw.data;
        return Array.isArray(items)
            ? items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            : [];
    }
    return [];
}

async function createDuckMailMailbox(provider: LegacyMailProviderConfig): Promise<Mailbox> {
    const apiKey = clean(provider.api_key);
    const domainPayload = await fetchJson("https://api.duckmail.sbs", "/domains", {
        headers: {Authorization: `Bearer ${apiKey}`},
        expected: [200, 201, 204],
    });
    const duckDomains = duckItems(domainPayload)
        .map((item) => clean(item.domain))
        .filter(Boolean);
    const domain = duckDomains.length
        ? duckDomains[Math.floor(Math.random() * duckDomains.length)]
        : clean(provider.default_domain) || "duckmail.sbs";
    const address = `${generateEmailName()}@${domain}`;
    const password = Math.random().toString(36).slice(2, 14);
    const body = {address, password};
    const account = await fetchJson("https://api.duckmail.sbs", "/accounts", {
        method: "POST",
        headers: {Authorization: `Bearer ${apiKey}`},
        body,
        expected: [200, 201, 204],
    }) as Record<string, unknown>;
    const tokenData = await fetchJson("https://api.duckmail.sbs", "/token", {
        method: "POST",
        headers: {Authorization: `Bearer ${apiKey}`},
        body,
        expected: [200, 201, 204],
    }) as Record<string, unknown>;
    const token = clean(tokenData.token);
    if (!token) {
        throw new Error("DuckMail 缺少 token");
    }
    return {provider: "duckmail", provider_ref: providerRef(provider), address, token, password, account_id: clean(account.id)};
}

async function fetchDuckMailMessage(mailbox: Mailbox): Promise<LegacyMailMessage | null> {
    const data = await fetchJson("https://api.duckmail.sbs", "/messages", {
        headers: {Authorization: `Bearer ${mailbox.token}`},
        query: {page: 1},
        expected: [200, 201, 204],
    });
    const items = duckItems(data);
    debugLog(`duckmail messages email=${mailbox.address} count=${items.length}`);
    if (!items.length) {
        return null;
    }
    const first = items[0];
    const rawId = clean(first.id) || clean(first["@id"]).replace("/messages/", "");
    const detail = rawId
        ? await fetchJson("https://api.duckmail.sbs", `/messages/${encodeURIComponent(rawId)}`, {
            headers: {Authorization: `Bearer ${mailbox.token}`},
            expected: [200, 201, 204],
        }) as Record<string, unknown>
        : first;
    debugLog(
        `duckmail detail email=${mailbox.address} id=${rawId} subject=${JSON.stringify(clean(detail.subject).slice(0, 120))} from=${JSON.stringify(clean(senderOf(detail)).slice(0, 120))} text=${JSON.stringify((clean(detail.text) || clean(detail.text_content)).slice(0, 200))} html=${JSON.stringify((Array.isArray(detail.html) ? detail.html.join("") : clean(detail.html)).slice(0, 200))}`,
    );
    return normalizeMessage("duckmail", detail, mailbox, {
        id: rawId,
        html_content: Array.isArray(detail.html) ? detail.html.join("") : clean(detail.html),
        text_content: clean(detail.text) || clean(detail.text_content),
    });
}

async function createGptMailMailbox(provider: LegacyMailProviderConfig): Promise<Mailbox> {
    const body = {
        prefix: generateEmailName(),
        ...(clean(provider.default_domain) ? {domain: clean(provider.default_domain)} : {}),
    };
    const data = await fetchJson("https://mail.chatgpt.org.uk", "/api/generate-email", {
        method: "POST",
        headers: {"X-API-Key": clean(provider.api_key)},
        body,
    }) as Record<string, unknown>;
    const address = clean(data.email);
    if (!address) {
        throw new Error("GPTMail 缺少 email");
    }
    return {provider: "gptmail", provider_ref: providerRef(provider), address};
}

async function fetchGptMailMessage(mailbox: Mailbox): Promise<LegacyMailMessage | null> {
    const data = await fetchJson("https://mail.chatgpt.org.uk", "/api/emails", {
        query: {email: mailbox.address},
    });
    const emails = Array.isArray(data) ? data : Array.isArray(data?.emails) ? data.emails : [];
    const messages = emails.filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    if (!messages.length) {
        return null;
    }
    const latest = messages.reduce((best, current) => {
        const currentKey = [Number(current.timestamp ?? 0) || 0, clean(current.id)];
        const bestKey = [Number(best.timestamp ?? 0) || 0, clean(best.id)];
        return currentKey[0] > bestKey[0] || (currentKey[0] === bestKey[0] && currentKey[1] > bestKey[1]) ? current : best;
    });
    const detail = clean(latest.id)
        ? await fetchJson("https://mail.chatgpt.org.uk", `/api/email/${encodeURIComponent(clean(latest.id))}`)
        : latest;
    return normalizeMessage("gptmail", detail as Record<string, unknown>, mailbox, {
        id: clean((detail as Record<string, unknown>).id) || clean(latest.id),
        sender: clean((detail as Record<string, unknown>).from_address) || clean(latest.from_address),
        text_content: clean((detail as Record<string, unknown>).content),
        html_content: clean((detail as Record<string, unknown>).html_content),
        timestamp: Number((detail as Record<string, unknown>).timestamp ?? (detail as Record<string, unknown>).created_at ?? latest.timestamp) || 0,
    });
}

async function createMoEmailMailbox(provider: LegacyMailProviderConfig): Promise<Mailbox> {
    const data = await fetchJson(clean(provider.api_base), "/api/emails/generate", {
        method: "POST",
        headers: {"X-API-Key": clean(provider.api_key)},
        body: {
            name: generateEmailName(),
            expiryTime: Number(provider.expiry_time ?? 0) || 0,
            domain: nextDomain(provider),
        },
        expected: [200, 201],
    }) as Record<string, unknown>;
    const address = clean(data.email);
    const emailId = clean(data.id) || clean(data.email_id);
    if (!address || !emailId) {
        throw new Error("MoEmail 缺少 email 或 id");
    }
    return {provider: "moemail", provider_ref: providerRef(provider), address, email_id: emailId};
}

async function fetchMoEmailMessage(provider: LegacyMailProviderConfig, mailbox: Mailbox): Promise<LegacyMailMessage | null> {
    const data = await fetchJson(clean(provider.api_base), `/api/emails/${encodeURIComponent(mailbox.email_id)}`, {
        headers: {"X-API-Key": clean(provider.api_key)},
    });
    const raw = Array.isArray(data?.messages) ? data.messages : [];
    const messages = raw.filter((value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
    if (!messages.length) {
        return null;
    }
    const latest = messages.reduce((best, current) => {
        const currentKey = [latestTimestamp(current), clean(current.id) || clean(current.message_id) || clean(current._id)];
        const bestKey = [latestTimestamp(best), clean(best.id) || clean(best.message_id) || clean(best._id)];
        return currentKey[0] > bestKey[0] || (currentKey[0] === bestKey[0] && currentKey[1] > bestKey[1]) ? current : best;
    });
    const messageId = clean(latest.id) || clean(latest.message_id) || clean(latest._id);
    const detail = messageId
        ? await fetchJson(clean(provider.api_base), `/api/emails/${encodeURIComponent(mailbox.email_id)}/${encodeURIComponent(messageId)}`, {
            headers: {"X-API-Key": clean(provider.api_key)},
        }) as Record<string, unknown>
        : {message: latest};
    const message = detail.message && typeof detail.message === "object"
        ? detail.message as Record<string, unknown>
        : detail;
    return normalizeMessage("moemail", message, mailbox, {
        id: messageId,
        timestamp: latestTimestamp(message) || latestTimestamp(latest),
    });
}

async function createYydsMailbox(provider: LegacyMailProviderConfig): Promise<Mailbox> {
    const baseUrl = clean(provider.api_base) || "https://maliapi.215.im/v1";
    const body: Record<string, unknown> = {localPart: generateEmailName()};
    const domainList = domains(provider);
    if (domainList.length) {
        body.domain = nextDomain(provider);
    }
    if (clean(provider.subdomain)) {
        body.subdomain = clean(provider.subdomain);
    }
    const data = await fetchJson(baseUrl, provider.wildcard ? "/accounts/wildcard" : "/accounts", {
        method: "POST",
        headers: {"X-API-Key": clean(provider.api_key)},
        body,
        expected: [200, 201, 204],
    }) as Record<string, unknown>;
    const address = clean(data.address) || clean(data.email);
    const token = clean(data.token) || clean(data.temp_token) || clean(data.tempToken) || clean(data.access_token);
    if (!address || !token) {
        throw new Error("YYDSMail 缺少 address 或 token");
    }
    return {provider: "yyds_mail", provider_ref: providerRef(provider), address, token, account_id: clean(data.id)};
}

async function fetchYydsMessage(provider: LegacyMailProviderConfig, mailbox: Mailbox): Promise<LegacyMailMessage | null> {
    const baseUrl = clean(provider.api_base) || "https://maliapi.215.im/v1";
    const data = await fetchJson(baseUrl, "/messages", {
        headers: {Authorization: `Bearer ${mailbox.token}`},
        query: {address: mailbox.address},
        expected: [200, 201, 204],
    });
    const raw = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.messages)
                ? data.messages
                : Array.isArray(data?.data)
                    ? data.data
                    : [];
    const messages = raw.filter((value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
    if (!messages.length) {
        return null;
    }
    const latest = messages.reduce((best, current) => {
        const currentKey = [latestTimestamp(current), clean(current.id) || clean(current.message_id)];
        const bestKey = [latestTimestamp(best), clean(best.id) || clean(best.message_id)];
        return currentKey[0] > bestKey[0] || (currentKey[0] === bestKey[0] && currentKey[1] > bestKey[1]) ? current : best;
    });
    const messageId = clean(latest.id) || clean(latest.message_id);
    const detail = messageId
        ? await fetchJson(baseUrl, `/messages/${encodeURIComponent(messageId)}`, {
            headers: {Authorization: `Bearer ${mailbox.token}`},
            query: {address: mailbox.address},
            expected: [200, 201, 204],
        }) as Record<string, unknown>
        : latest;
    return normalizeMessage("yyds_mail", detail, mailbox, {id: messageId});
}

export function createLegacyProvider() {
    return {
        async getEmailAddress() {
            const provider = nextProvider();
            switch (clean(provider.type)) {
                case "cloudflare_temp_email":
                    return (await createCloudflareTempMailbox(provider)).address;
                case "tempmail_lol":
                    return (await createTempMailLolMailbox(provider)).address;
                case "duckmail":
                    return (await createDuckMailMailbox(provider)).address;
                case "gptmail":
                    return (await createGptMailMailbox(provider)).address;
                case "moemail":
                    return (await createMoEmailMailbox(provider)).address;
                case "yyds_mail":
                    return (await createYydsMailbox(provider)).address;
                default:
                    throw new Error(`不支持的 mail.provider: ${provider.type}`);
            }
        },
        async getEmailVerificationCode(email: string) {
            throw new Error(`旧邮箱 Provider 需要带 mailbox 状态读取验证码: ${email}`);
        },
        async createMailbox() {
            const provider = nextProvider();
            switch (clean(provider.type)) {
                case "cloudflare_temp_email":
                    return createCloudflareTempMailbox(provider);
                case "tempmail_lol":
                    return createTempMailLolMailbox(provider);
                case "duckmail":
                    return createDuckMailMailbox(provider);
                case "gptmail":
                    return createGptMailMailbox(provider);
                case "moemail":
                    return createMoEmailMailbox(provider);
                case "yyds_mail":
                    return createYydsMailbox(provider);
                default:
                    throw new Error(`不支持的 mail.provider: ${provider.type}`);
            }
        },
        async getMailboxVerificationCode(mailbox: Mailbox) {
            const provider = providerByMailbox(mailbox);
            switch (clean(provider.type)) {
                case "cloudflare_temp_email":
                    return pollVerificationCode(mailbox, () => fetchCloudflareTempMessage(provider, mailbox));
                case "tempmail_lol":
                    return pollVerificationCode(mailbox, () => fetchTempMailLolMessage(mailbox));
                case "duckmail":
                    return pollVerificationCode(mailbox, () => fetchDuckMailMessage(mailbox));
                case "gptmail":
                    return pollVerificationCode(mailbox, () => fetchGptMailMessage(mailbox));
                case "moemail":
                    return pollVerificationCode(mailbox, () => fetchMoEmailMessage(provider, mailbox));
                case "yyds_mail":
                    return pollVerificationCode(mailbox, () => fetchYydsMessage(provider, mailbox));
                default:
                    throw new Error(`不支持的 mail.provider: ${provider.type}`);
            }
        },
    };
}
