import axios, { AxiosError, AxiosHeaders, type AxiosRequestConfig, type InternalAxiosRequestConfig } from "axios";

import webConfig from "@/constants/common-env";
import { clearStoredAuthKey, getStoredAuthKey, type AuthScope } from "@/store/auth";

type RequestConfig = AxiosRequestConfig & {
  authScope?: AuthScope;
  redirectOnUnauthorized?: boolean;
};

const request = axios.create({
  baseURL: webConfig.apiUrl.replace(/\/$/, ""),
  timeout: 300000,
});

function getLoginPath(scope: AuthScope) {
  return scope === "admin" ? "/admin/login" : "/login";
}

request.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const nextConfig = config as InternalAxiosRequestConfig & RequestConfig;
  const scope = nextConfig.authScope ?? "admin";
  const authKey = await getStoredAuthKey(scope);
  const headers = AxiosHeaders.from(nextConfig.headers || {});

  if (authKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${authKey}`);
  }

  nextConfig.headers = headers;
  return nextConfig;
});

request.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ detail?: { error?: string }; error?: string; message?: string }>) => {
    const status = error.response?.status;
    const config = (error.config || {}) as RequestConfig;
    const scope = config.authScope ?? "admin";
    const shouldRedirect = config.redirectOnUnauthorized !== false;

    if (status === 401 && shouldRedirect && typeof window !== "undefined") {
      const loginPath = getLoginPath(scope);
      if (!window.location.pathname.startsWith(loginPath)) {
        await clearStoredAuthKey(scope);
        window.location.replace(loginPath);
        return new Promise(() => {});
      }
    }

    const payload = error.response?.data;
    const message =
      payload?.detail?.error ||
      payload?.error ||
      payload?.message ||
      error.message ||
      `请求失败 (${status || 500})`;
    return Promise.reject(new Error(message));
  },
);

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  authScope?: AuthScope;
  redirectOnUnauthorized?: boolean;
};

export async function httpRequest<T>(path: string, options: RequestOptions = {}) {
  const { method = "GET", body, headers, authScope = "admin", redirectOnUnauthorized = true } = options;
  const config: RequestConfig = {
    url: path,
    method,
    data: body,
    headers,
    authScope,
    redirectOnUnauthorized,
  };
  const response = await request.request<T>(config);
  return response.data;
}
