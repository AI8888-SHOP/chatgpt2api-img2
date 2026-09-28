"use client";

import localforage from "localforage";

export type AuthScope = "admin" | "user";

export const AUTH_KEY_STORAGE_KEYS: Record<AuthScope, string> = {
  admin: "chatgpt2api_admin_auth_key",
  user: "chatgpt2api_user_auth_key",
};

const authStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "auth",
});

function getStorageKey(scope: AuthScope) {
  return AUTH_KEY_STORAGE_KEYS[scope];
}

export async function getStoredAuthKey(scope: AuthScope) {
  if (typeof window === "undefined") {
    return "";
  }
  const value = await authStorage.getItem<string>(getStorageKey(scope));
  return String(value || "").trim();
}

export async function setStoredAuthKey(scope: AuthScope, authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  if (!normalizedAuthKey) {
    await clearStoredAuthKey(scope);
    return;
  }
  await authStorage.setItem(getStorageKey(scope), normalizedAuthKey);
}

export async function clearStoredAuthKey(scope: AuthScope) {
  if (typeof window === "undefined") {
    return;
  }
  await authStorage.removeItem(getStorageKey(scope));
}
