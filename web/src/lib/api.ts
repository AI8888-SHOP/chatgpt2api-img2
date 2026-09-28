import { httpRequest } from "@/lib/request";

export type AccountType = "Free" | "Plus" | "Pro" | "Team" | "Enterprise";
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = "gpt-image-2" | "grok-imagine-image";

export type Account = {
  id: string;
  access_token: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restoreAt?: string | null;
  success: number;
  fail: number;
  lastUsedAt: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token: string; error: string }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type SettingsConfig = {
  editable_studio?: import("@/lib/editable-studio").StudioAdminConfig;
  prompt_optimizer?: PromptOptimizerConfig;
  site_title?: string;
  proxy: string;
  image_upstreams?: ImageUpstreamConfig[];
  image_upstream_cooldown_secs?: number;
  quick_prompts?: QuickPromptConfig[];
  "auth-key"?: string;
  default_user_quota?: number;
  user_registration_enabled?: boolean;
  invite_registration_enabled?: boolean;
  invite_inviter_quota?: number;
  invite_invited_quota?: number;
  psd_task_price?: number;
  auto_remove_abnormal_accounts?: boolean;
  register_email_verification_enabled?: boolean;
  register_email_domain_whitelist?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_username?: string;
  smtp_password?: string;
  smtp_from_email?: string;
  smtp_from_name?: string;
  smtp_tls_enabled?: boolean;
  refresh_account_interval_minute?: number;
  [key: string]: unknown;
};

export type PublicAppConfig = {
  site_title: string;
  quick_prompts?: QuickPromptConfig[];
  psd_task_price?: number;
};

export type PromptOptimizerConfig = {
  enabled: boolean;
  base_url: string;
  api_key: string;
  has_api_key?: boolean;
  clear_api_key?: boolean;
  model: string;
  token_parameter: "max_completion_tokens" | "max_tokens";
  tokenizer: "cl100k_base" | "o200k_base";
  max_input_tokens: number;
  max_output_tokens: number;
  user_rpm: number;
  user_daily_requests: number;
  user_daily_tokens: number;
  user_concurrency: number;
  global_rpm: number;
  global_daily_requests: number;
  global_daily_tokens: number;
  global_concurrency: number;
  timeout_seconds: number;
  min_quota: number;
  min_account_age_seconds: number;
};

export type QuickPromptConfig = {
  label: string;
  content: string;
};

export type ImageUpstreamConfig = {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: boolean;
};

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<{ ok: boolean }>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    authScope: "admin",
    redirectOnUnauthorized: false,
  });
}

export async function adminLogin(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<{ ok: boolean }>("/admin/api/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    authScope: "admin",
    redirectOnUnauthorized: false,
  });
}

export type UserKeyInfo = {
  name: string;
  email?: string;
  total_usage: number;
  remaining: number;
  quota?: number;
  expires_at: number;
  created_at: number;
  enabled: boolean;
};

export async function userLoginWithPassword(email: string, password: string) {
  return httpRequest<{ token: string; user: UserKeyInfo }>("/auth/user/login", {
    method: "POST",
    body: { email, password },
    authScope: "user",
    redirectOnUnauthorized: false,
  });
}

export async function registerUser(email: string, password: string, verificationCode?: string, inviteCode?: string) {
  return httpRequest<{ user: UserKeyInfo }>("/auth/register", {
    method: "POST",
    body: { email, password, verification_code: verificationCode || "", invite_code: inviteCode || "" },
    authScope: "user",
    redirectOnUnauthorized: false,
  });
}

export async function fetchUserRegisterConfig() {
  return httpRequest<{
    enabled: boolean;
    default_user_quota: number;
    email_verification_enabled: boolean;
    email_domain_whitelist: string[];
    invite_enabled: boolean;
    invite_inviter_quota: number;
    invite_invited_quota: number;
  }>("/auth/register-config", {
    redirectOnUnauthorized: false,
  });
}

export async function sendRegisterEmailCode(email: string) {
  return httpRequest<{ success: boolean }>("/auth/register/email-code", {
    method: "POST",
    body: { email },
    authScope: "user",
    redirectOnUnauthorized: false,
  });
}

export async function redeemUserCode(code: string) {
  return httpRequest<{ success: boolean; amount: number; user: UserKeyInfo }>("/v1/key/redeem", {
    method: "POST",
    body: { code },
    authScope: "user",
  });
}

export type UserOwnedApiKey = {
  key: string;
  user_id: string;
  name: string;
  created_at: number;
  last_used_at: number;
  enabled: boolean;
};

export type UserInviteInfo = {
  code: string;
  enabled: boolean;
  inviter_quota: number;
  invited_quota: number;
  total_invites: number;
  recent: Array<{
    id: string;
    inviter_id: string;
    invited_user_id: string;
    invited_email?: string;
    code: string;
    inviter_amount: number;
    invited_amount: number;
    created_at: number;
  }>;
};

export type UserQuotaLedgerItem = {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  reason: string;
  reference: string;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type AdminImageConversationItem = {
  id: string;
  title: string;
  prompt: string;
  model: string;
  mode?: "generate" | "edit";
  count: number;
  images?: Array<{ id: string; status?: string; url?: string; b64_json?: string; error?: string }>;
  createdAt: string;
  status: "generating" | "success" | "error";
  error?: string;
};

export async function fetchUserApiKeys() {
  return httpRequest<{ api_keys: UserOwnedApiKey[] }>("/v1/user/api-keys", { authScope: "user" });
}

export async function createUserApiKey(name: string) {
  return httpRequest<{ success: boolean; key: string; api_key: UserOwnedApiKey }>("/v1/user/api-keys", {
    method: "POST",
    body: { name },
    authScope: "user",
  });
}

export async function updateUserApiKey(key: string, updates: { name?: string; enabled?: boolean }) {
  return httpRequest<{ success: boolean; api_key: UserOwnedApiKey }>(`/v1/user/api-keys/${key}`, {
    method: "PUT",
    body: updates,
    authScope: "user",
  });
}

export async function deleteUserApiKey(key: string) {
  return httpRequest<{ success: boolean }>(`/v1/user/api-keys/${key}`, {
    method: "DELETE",
    authScope: "user",
  });
}

export async function fetchUserInviteInfo() {
  return httpRequest<{ invite: UserInviteInfo }>("/v1/user/invite", { authScope: "user" });
}

export type AdminUserSummary = {
  id: string;
  email: string;
  quota: number;
  total_usage: number;
  total_redeemed: number;
  created_at: number;
  updated_at: number;
  enabled: boolean;
};

export async function fetchAdminUsers(params?: { query?: string; limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  if (params?.query) query.set("query", params.query);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  return httpRequest<{ users: AdminUserSummary[]; total: number; limit: number; offset: number; has_more: boolean }>(
    `/admin/api/users${query.size ? `?${query.toString()}` : ""}`,
    { authScope: "admin" },
  );
}

export async function fetchAdminUserDetail(userId: string) {
  return httpRequest<{
    user: AdminUserSummary;
    api_keys: UserOwnedApiKey[];
    quota_ledger: { records: UserQuotaLedgerItem[]; total: number; limit: number; offset: number; has_more: boolean };
    image_conversations: { items: AdminImageConversationItem[]; total: number; limit: number; offset: number; has_more: boolean };
  }>(`/admin/api/users/${userId}`, {
    authScope: "admin",
  });
}

export async function createAdminUser(payload: { email: string; password: string; quota?: number; enabled?: boolean }) {
  return httpRequest<{ success: boolean; user: AdminUserSummary }>("/admin/api/users", {
    method: "POST",
    body: payload,
    authScope: "admin",
  });
}

export async function updateAdminUser(
  userId: string,
  payload: { email?: string; password?: string; quota?: number; enabled?: boolean },
) {
  return httpRequest<{ success: boolean; user: AdminUserSummary }>(`/admin/api/users/${userId}`, {
    method: "PUT",
    body: payload,
    authScope: "admin",
  });
}

export async function adjustAdminUserQuota(userId: string, amount: number) {
  return httpRequest<{ success: boolean; user: AdminUserSummary }>(`/admin/api/users/${userId}/quota`, {
    method: "POST",
    body: { amount },
    authScope: "admin",
  });
}

export async function deleteAdminUser(userId: string) {
  return httpRequest<{ success: boolean }>(`/admin/api/users/${userId}`, {
    method: "DELETE",
    authScope: "admin",
  });
}

export async function deleteAdminUserApiKey(userId: string, key: string) {
  return httpRequest<{ success: boolean }>(`/admin/api/users/${userId}/api-keys/${key}`, {
    method: "DELETE",
    authScope: "admin",
  });
}

export async function deleteAdminUserImageConversation(userId: string, conversationId: string) {
  return httpRequest<{ success: boolean; deleted: boolean }>(
    `/admin/api/users/${userId}/image-conversations/${conversationId}`,
    {
      method: "DELETE",
      authScope: "admin",
    },
  );
}

export async function clearAdminUserImageConversations(userId: string) {
  return httpRequest<{ success: boolean; deleted: number }>(`/admin/api/users/${userId}/image-conversations`, {
    method: "DELETE",
    authScope: "admin",
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts", { authScope: "admin" });
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
    authScope: "admin",
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
    authScope: "admin",
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
    authScope: "admin",
  });
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
    authScope: "admin",
  });
}

export type RegisterMailProvider = {
  enable?: boolean;
  type?: string;
  api_base?: string;
  admin_email?: string;
  admin_password?: string;
  api_key?: string;
  domain?: string[] | string;
  subdomain?: string[] | string | string;
  subdomain_levels?: string[] | string;
  fixed_address?: string;
  append_random_suffix?: boolean;
  random_subdomain_depth?: number;
  email_prefix?: string;
  default_domain?: string;
  wildcard?: boolean;
  mode?: string;
  imap_host?: string;
  mailboxes?: string;
  mailboxes_count?: number;
  mailboxes_preview?: string[];
  mailboxes_stats?: Record<string, number>;
  [key: string]: unknown;
};

export type RegisterConfig = {
  enabled: boolean;
  mail: {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    api_use_register_proxy?: boolean;
    providers: RegisterMailProvider[];
    [key: string]: unknown;
  };
  proxy: string;
  total: number;
  threads: number;
  mode: "total" | "quota" | "available" | string;
  target_quota: number;
  target_available: number;
  check_interval: number;
  auto_register_enabled?: boolean;
  auto_register_min_quota?: number;
  default_password?: string;
  // legacy/local optional fields kept for backward compatibility
  engine?: "chatgpt" | "codex" | string;
  codex?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  logs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};


export async function fetchRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register", { authScope: "admin" });
}

export async function updateRegisterConfig(config: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register", {
    method: "POST",
    body: config,
    authScope: "admin",
  });
}

export async function startRegister(config?: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", {
    method: "POST",
    body: config,
    authScope: "admin",
  });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", {
    method: "POST",
    authScope: "admin",
  });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", {
    method: "POST",
    authScope: "admin",
  });
}

export async function resetOutlookPool(scope: "all" | "failed" | "unused" = "all") {
  return httpRequest<{ register: RegisterConfig }>("/api/register/outlook-pool/reset", {
    method: "POST",
    body: { scope },
    authScope: "admin",
  });
}

export async function createRegisterEventsToken() {
  return httpRequest<{ token: string; expires_at: number }>("/api/register/events-token", {
    method: "POST",
    authScope: "admin",
  });
}

export async function fetchNewRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/new", { authScope: "admin" });
}

export async function startNewRegister(config?: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register/new/start", {
    method: "POST",
    body: config,
    authScope: "admin",
  });
}

export async function stopNewRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/new/stop", {
    method: "POST",
    authScope: "admin",
  });
}

export async function resetNewRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/new/reset", {
    method: "POST",
    authScope: "admin",
  });
}

export async function fetchGptFreeRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/gptfree", { authScope: "admin" });
}

export async function startGptFreeRegister(config?: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register/gptfree/start", {
    method: "POST",
    body: config,
    authScope: "admin",
  });
}

export async function stopGptFreeRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/gptfree/stop", {
    method: "POST",
    authScope: "admin",
  });
}

export async function resetGptFreeRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/gptfree/reset", {
    method: "POST",
    authScope: "admin",
  });
}

export type ImageGenParams = {
  prompt: string;
  model?: ImageModel;
  n?: number;
  quality?: string;
  size?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
};

export async function generateImage(prompt: string, model: ImageModel = "gpt-image-2", params?: Partial<ImageGenParams>) {
  return httpRequest<{ created: number; data: Array<{ url: string; revised_prompt?: string }> }>(
    "/v1/images/generations",
    {
      method: "POST",
      body: {
        prompt,
        model,
        n: 1,
        response_format: "url",
        ...params,
      },
      authScope: "user",
    },
  );
}

export type ImageJobResult = { created: number; data: Array<{ url: string; revised_prompt?: string }> };
export type ImageJobStatus = {
  job_id: string;
  status: "pending" | "running" | "success" | "error";
  result?: ImageJobResult | null;
  error?: string;
  progress?: string;
  progress_text?: string;
  can_resume?: boolean;
  conversation_id?: string;
  client_conversation_id?: string;
  client_image_id?: string;
};

export async function createImageGenerationJob(
  prompt: string,
  model: ImageModel = "gpt-image-2",
  params?: Partial<ImageGenParams> & { client_conversation_id?: string; client_image_id?: string },
) {
  return httpRequest<{ job_id: string; status: string }>("/v1/image-jobs/generations", {
    method: "POST",
    body: {
      prompt,
      model,
      n: 1,
      response_format: "url",
      ...params,
    },
    authScope: "user",
  });
}

export async function optimizeImagePrompt(prompt: string) {
  return httpRequest<{ optimized_prompt: string; truncated?: boolean }>("/v1/image-prompts/optimize", {
    method: "POST",
    body: { prompt },
    authScope: "user",
  });
}

export async function editImage(files: File | File[], prompt: string, model: ImageModel = "gpt-image-2") {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  formData.append("model", model);
  formData.append("n", "1");

  return httpRequest<{ created: number; data: Array<{ url: string; revised_prompt?: string }> }>(
    "/v1/images/edits",
    {
      method: "POST",
      body: formData,
      authScope: "user",
    },
  );
}

export async function createImageEditJob(
  files: File | File[],
  prompt: string,
  model: ImageModel = "gpt-image-2",
  clientIds?: { client_conversation_id?: string; client_image_id?: string },
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  formData.append("model", model);
  formData.append("n", "1");
  if (clientIds?.client_conversation_id) formData.append("client_conversation_id", clientIds.client_conversation_id);
  if (clientIds?.client_image_id) formData.append("client_image_id", clientIds.client_image_id);

  return httpRequest<{ job_id: string; status: string }>("/v1/image-jobs/edits", {
    method: "POST",
    body: formData,
    authScope: "user",
  });
}

export async function fetchImageJobs(params?: { client_conversation_id?: string; limit?: number }) {
  const query = new URLSearchParams();
  if (params?.client_conversation_id) query.set("client_conversation_id", params.client_conversation_id);
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return httpRequest<{ items: ImageJobStatus[] }>(`/v1/image-jobs${suffix}`, {
    authScope: "user",
  });
}

export async function fetchImageJob(jobId: string) {
  return httpRequest<ImageJobStatus>(`/v1/image-jobs/${jobId}`, {
    authScope: "user",
  });
}

export async function resumeImageJobPoll(jobId: string, extraTimeoutSecs = 60) {
  return httpRequest<{ job_id: string; status: string }>(`/v1/image-jobs/${jobId}/resume-poll`, {
    method: "POST",
    body: { extra_timeout_secs: extraTimeoutSecs },
    authScope: "user",
  });
}

export async function fetchUserKeyInfo() {
  return httpRequest<UserKeyInfo>("/v1/key/info", {
    authScope: "user",
  });
}

export async function fetchPublicAppConfig() {
  return httpRequest<PublicAppConfig>("/app-config", {
    authScope: "user",
    redirectOnUnauthorized: false,
  });
}

export type EditableFileKind = "ppt" | "psd";
export type EditableFileTaskStatus = "queued" | "running" | "success" | "error";
export type EditableFileTask = {
  id?: string;
  taskId?: string;
  status: EditableFileTaskStatus | string;
  kind: EditableFileKind;
  created_at?: string;
  updated_at?: string;
  elapsed_seconds?: number;
  prompt_preview?: string;
  polled_at?: number;
  conversation_id?: string;
  result?: {
    conversation_id?: string;
    primary_url?: string;
    zip_url?: string;
  };
  error?: string;
};

export async function createEditableFileTask(kind: EditableFileKind, payload: { prompt: string; base64_images: string[]; client_task_id?: string }) {
  return httpRequest<EditableFileTask>(`/v1/${kind}/generations`, {
    method: "POST",
    body: payload,
    authScope: "user",
  });
}

export async function fetchEditableFileTasks(ids?: string[]) {
  const taskIds = Array.from(new Set((ids || []).map((item) => item.trim()).filter(Boolean)));
  const path = taskIds.length ? `/v1/editable-file-tasks?ids=${taskIds.map(encodeURIComponent).join(",")}` : "/v1/editable-file-tasks";
  return httpRequest<{ items: EditableFileTask[]; missing_ids?: string[] }>(path, {
    authScope: "user",
  });
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", { authScope: "admin" });
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
    authScope: "admin",
  });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools", { authScope: "admin" });
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
    authScope: "admin",
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
    authScope: "admin",
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
    authScope: "admin",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(`/api/cpa/pools/${poolId}/files`, {
    authScope: "admin",
  });
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    method: "POST",
    body: { names },
    authScope: "admin",
  });
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    authScope: "admin",
  });
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  return httpRequest<{ servers: Sub2APIServer[] }>("/api/sub2api/servers", { authScope: "admin" });
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>("/api/sub2api/servers", {
    method: "POST",
    body: server,
    authScope: "admin",
  });
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "POST",
    body: updates,
    authScope: "admin",
  });
}

export async function fetchSub2APIServerGroups(serverId: string) {
  return httpRequest<{ server_id: string; groups: Sub2APIRemoteGroup[] }>(
    `/api/sub2api/servers/${serverId}/groups`,
    { authScope: "admin" },
  );
}

export async function deleteSub2APIServer(serverId: string) {
  return httpRequest<{ servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "DELETE",
    authScope: "admin",
  });
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  return httpRequest<{ server_id: string; accounts: Sub2APIRemoteAccount[] }>(
    `/api/sub2api/servers/${serverId}/accounts`,
    { authScope: "admin" },
  );
}

export async function startSub2APIImport(serverId: string, accountIds: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    method: "POST",
    body: { account_ids: accountIds },
    authScope: "admin",
  });
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    authScope: "admin",
  });
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", { authScope: "admin" });
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
    authScope: "admin",
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
    authScope: "admin",
  });
}

export type ApiKeySummary = {
  key: string;
  full_key?: string;
  full_key_available?: boolean;
  name: string;
  customer_name: string;
  channel: string;
  package_name: string;
  batch_code: string;
  total_usage: number;
  max_usage: number;
  credit_amount?: number;
  redeemed_by?: string;
  redeemed_at?: number;
  created_at: number;
  expires_at: number;
  enabled: boolean;
  is_admin: boolean;
  is_valid?: boolean;
  created_at_str?: string;
  expires_at_str?: string;
};

export type UsageRecordItem = {
  id: string;
  api_key: string;
  api_key_name: string;
  action: string;
  prompt: string;
  model: string;
  status: string;
  error: string;
  duration_ms: number;
  timestamp: number;
  timestamp_str?: string;
};

export type UsageStats = {
  total: number;
  success: number;
  failed: number;
  avg_duration_ms: number;
  daily_stats: Record<string, { total: number; success: number; failed: number }>;
  action_stats: Record<string, { total: number; success: number; failed: number }>;
  period_days: number;
};

export type GeneratedImageCacheItem = {
  id: string;
  url: string;
  relative_path: string;
  file_name: string;
  created_at: number;
  size_bytes: number;
  content_type: string;
  prompt: string;
  model: string;
  action: string;
  api_key: string;
  api_key_name: string;
};

export type AdminAuditRecord = {
  id: string;
  admin: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  timestamp: number;
};

export type AdminSystemInfo = {
  version: string;
  keys_total: number;
  keys_enabled: number;
  admin_keys: number;
};

export type AdminAccountStats = {
  total: number;
  active: number;
  limited: number;
  error: number;
  disabled: number;
};

export async function fetchAdminSystemInfo() {
  return httpRequest<AdminSystemInfo>("/admin/api/system", { authScope: "admin" });
}

export async function fetchAdminAccountStats() {
  return httpRequest<AdminAccountStats>("/admin/api/accounts/stats", { authScope: "admin" });
}

export async function fetchAdminAuditRecords(params?: { action?: string; limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  if (params?.action) query.set("action", params.action);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  return httpRequest<{ records: AdminAuditRecord[]; total: number; offset: number; limit: number; has_more: boolean }>(
    `/admin/api/audit${query.size ? `?${query.toString()}` : ""}`,
    { authScope: "admin" },
  );
}

export async function fetchAdminKeys() {
  return httpRequest<{ keys: ApiKeySummary[] }>("/admin/api/keys", { authScope: "admin" });
}

export async function createAdminKey(payload: {
  name: string;
  customer_name: string;
  channel: string;
  package_name: string;
  batch_code: string;
  max_usage: number;
  expires_days: number;
  is_admin: boolean;
}) {
  return httpRequest<{ success: boolean; key: string; api_key: ApiKeySummary }>("/admin/api/keys", {
    method: "POST",
    body: payload,
    authScope: "admin",
  });
}

export async function updateAdminKey(
  key: string,
  updates: {
    name?: string;
    customer_name?: string;
    channel?: string;
    package_name?: string;
    batch_code?: string;
    enabled?: boolean;
    max_usage?: number;
    expires_days?: number;
  },
) {
  const query = new URLSearchParams();
  Object.entries(updates).forEach(([field, value]) => {
    if (value !== undefined && value !== null) {
      query.set(field, String(value));
    }
  });
  return httpRequest<{ success: boolean; api_key: ApiKeySummary }>(`/admin/api/keys/${key}?${query.toString()}`, {
    method: "PUT",
    authScope: "admin",
  });
}

export async function deleteAdminKey(key: string) {
  return httpRequest<{ success: boolean }>(`/admin/api/keys/${key}`, {
    method: "DELETE",
    authScope: "admin",
  });
}

export async function resetAdminKeyUsage(key: string) {
  return httpRequest<{ success: boolean }>(`/admin/api/keys/${key}/reset`, {
    method: "POST",
    authScope: "admin",
  });
}

export async function addAdminKeyUsage(key: string, amount: number) {
  return httpRequest<{ success: boolean; api_key: ApiKeySummary }>(
    `/admin/api/keys/${key}/add-usage?amount=${encodeURIComponent(String(amount))}`,
    {
      method: "POST",
      authScope: "admin",
    },
  );
}

export async function fetchAdminUsageRecords(params?: { api_key?: string; limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  if (params?.api_key) query.set("api_key", params.api_key);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  return httpRequest<{ records: UsageRecordItem[]; total: number; offset: number; limit: number; has_more: boolean }>(
    `/admin/api/usage/records${query.size ? `?${query.toString()}` : ""}`,
    { authScope: "admin" },
  );
}

export async function fetchAdminUsageStats(params?: { api_key?: string; days?: number }) {
  const query = new URLSearchParams();
  if (params?.api_key) query.set("api_key", params.api_key);
  if (params?.days) query.set("days", String(params.days));
  return httpRequest<UsageStats>(`/admin/api/usage/stats${query.size ? `?${query.toString()}` : ""}`, {
    authScope: "admin",
  });
}

export async function clearAdminUsageRecords(days: number) {
  return httpRequest<{ success: boolean; message: string }>(
    `/admin/api/usage/records?days=${encodeURIComponent(String(days))}`,
    {
      method: "DELETE",
      authScope: "admin",
    },
  );
}

export async function fetchAdminGeneratedImages(params?: {
  query?: string;
  action?: string;
  limit?: number;
  offset?: number;
}) {
  const query = new URLSearchParams();
  if (params?.query) query.set("query", params.query);
  if (params?.action) query.set("action", params.action);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  return httpRequest<{
    items: GeneratedImageCacheItem[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
    total_size_bytes: number;
  }>(`/admin/api/generated-images${query.size ? `?${query.toString()}` : ""}`, {
    authScope: "admin",
  });
}

export async function deleteAdminGeneratedImages(ids: string[]) {
  return httpRequest<{ success: boolean; deleted: number; missing_ids: string[] }>("/admin/api/generated-images", {
    method: "DELETE",
    body: { ids },
    authScope: "admin",
  });
}
