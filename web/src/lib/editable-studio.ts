import { httpRequest } from "@/lib/request";
export type StudioKind = "ppt" | "psd";
export type StudioSlide = { title: string; body: string[]; layout: "cover" | "content" | "two_column" | "image" | "chart" | "closing"; image_index: number | null; chart_labels: string[]; chart_values: number[]; notes: string };
export type StudioLayer = { name: string; kind: "subject" | "text" | "logo" | "decoration"; box: number[]; polygon: number[][]; text: string };
export type StudioPlan = { kind: StudioKind; title: string; summary: string; template_id: string; slides: StudioSlide[]; layers: StudioLayer[]; warnings: string[]; fill_background: boolean };
export type PlanResult = { plan_id: string; plan: StudioPlan; price: number; revision: number; expires_in: number };
export type StudioPlanTask = { id: string; client_task_id: string; kind: StudioKind; status: "preparing" | "queued" | "running" | "success" | "failed"; phase: string; error: string; created_at: string; elapsed_seconds: number; expired: boolean; reference_urls: string[]; submitted_job_id?: string | null; request: { prompt: string; template_id: string; page_count: number; layer_count: number; fill_background: boolean; previous_plan_id?: string | null }; result?: PlanResult };
export type RequirementOptimization = { optimized_prompt: string; truncated: boolean };
export type StudioConfig = { enabled: boolean; optimization: { enabled: boolean; timeout_seconds: number; max_input_tokens: number; max_output_tokens: number; user_rpm: number; user_daily_requests: number }; templates: { id: string; name: string; description: string; background: string; foreground: string; accent: string }[]; limits: Record<string, number> };
export type StudioJob = { id: string; kind: StudioKind; title: string; status: string; phase: string; price: number; error: string; created_at: string; elapsed_seconds: number; expired?: boolean; result?: { primary_url: string; zip_url: string; previews: string[]; original_url?: string; editable_text: boolean; slide_count?: number; layer_count?: number; warnings: string[] } };
export type StudioAdminConfig = { enabled: boolean; reuse_optimizer_connection: boolean; base_url: string; api_key: string; has_api_key?: boolean; clear_api_key?: boolean; model: string; protocol: string; reasoning_effort: string; [key: string]: string | number | boolean | undefined };
const root = "/v1/editable-studio";
export const getStudioConfig = () => httpRequest<StudioConfig>(root + "/config", { authScope: "user" });
export const getStudioJobs = () => httpRequest<{ items: StudioJob[] }>(root + "/jobs", { authScope: "user" });
export const getStudioPlans = () => httpRequest<{ items: StudioPlanTask[] }>(root + "/plans", { authScope: "user", timeout: 15000 });
export const getStudioPlan = (id: string) => httpRequest<StudioPlanTask>(root + "/plans/" + encodeURIComponent(id), { authScope: "user", timeout: 15000 });
export const optimizeStudioRequirement = (kind: StudioKind, prompt: string) => httpRequest<RequirementOptimization>(root + "/requirements/optimize", { method: "POST", body: { kind, prompt }, authScope: "user", timeout: 40000 });
export const planStudio = (body: unknown) => httpRequest<StudioPlanTask>(root + "/plans", { method: "POST", body, authScope: "user", timeout: 45000 });
export const generateStudio = (body: unknown) => httpRequest<StudioJob>(root + "/jobs", { method: "POST", body, authScope: "user" });
export function privateFileUrl(raw: string) {
  const path = new URL(raw, "https://local.invalid").pathname;
  if (!path.startsWith(root + "/jobs/") && !path.startsWith("/files/") && !/^\/v1\/editable-studio\/plans\/[a-f0-9]{32}\/images\/\d+$/.test(path)) throw new Error("无效的文件地址");
  return path;
}
export const studioFile = (path: string) => httpRequest<Blob>(privateFileUrl(path), { authScope: "user", responseType: "blob" });
export async function downloadStudioFile(path: string, name: string) {
  const blob = await studioFile(path);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
