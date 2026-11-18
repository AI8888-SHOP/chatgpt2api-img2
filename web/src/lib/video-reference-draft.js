import localforage from "localforage";
// A tab-scoped token survives static-export route redirects. Image stays in IndexedDB.
const storage = localforage.createInstance({ name: "chatgpt2api", storeName: "video_reference_handoff" });
const tokenKey = "video-reference-handoff";
/** @type {{ file: File; expires: number } | null} */
let draft = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let expiry;

/** @param {File} file */
export async function stageVideoReference(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("图生视频支持 PNG、JPEG、WebP；请先将此图片转换为支持的格式");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("视频参考图最多 5 MB，请压缩后再上传到视频工作室");
  clearTimeout(expiry);
  draft = { file, expires: Date.now() + 60000 };
  const stale = await storage.keys();
  for (const key of stale) {
    const item = /** @type {{expires: number} | null} */ (await storage.getItem(key));
    if (!item || item.expires <= Date.now()) await storage.removeItem(key);
  }
  const token = crypto.randomUUID();
  await storage.setItem(token, draft);
  sessionStorage.setItem(tokenKey, token);
  expiry = setTimeout(() => { draft = null; }, 60000);
}

export async function takeVideoReference() {
  const token = sessionStorage.getItem(tokenKey);
  sessionStorage.removeItem(tokenKey);
  const current = token ? /** @type {{file: File; expires: number} | null} */ (await storage.getItem(token)) : draft;
  if (token) await storage.removeItem(token);
  draft = null;
  clearTimeout(expiry);
  return current && current.expires > Date.now() ? new File([current.file], "reference." + (current.file.type.split("/")[1] || "png"), {type: current.file.type}) : null;
}
