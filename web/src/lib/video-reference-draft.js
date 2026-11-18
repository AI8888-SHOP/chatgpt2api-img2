// One-shot, short-lived handoff. No private image data in URLs or local storage.
/** @type {{ file: File; expires: number } | null} */
let draft = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let expiry;

/** @param {File} file */
export function stageVideoReference(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("图生视频支持 PNG、JPEG、WebP；请先将此图片转换为支持的格式");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("视频参考图最多 5 MB，请压缩后再上传到视频工作室");
  clearTimeout(expiry);
  draft = { file, expires: Date.now() + 60000 };
  expiry = setTimeout(() => { draft = null; }, 60000);
}

export function takeVideoReference() {
  const current = draft;
  draft = null;
  clearTimeout(expiry);
  return current && current.expires > Date.now() ? current.file : null;
}
