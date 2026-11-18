// Request presets, not a provider capability declaration. Unknown models keep
// arbitrary valid dimensions and let their upstream validate actual support.
const RATIOS = [[1, 1], [3, 2], [2, 3], [4, 3], [3, 4], [16, 9], [9, 16]];
export const IMAGE_SIZE_PRESETS = [1024, 2048, 4096].flatMap(edge => RATIOS.map(([w, h]) => {
  const width = w >= h ? edge : Math.round(edge * w / h / 16) * 16;
  const height = w >= h ? Math.round(edge * h / w / 16) * 16 : edge;
  const value = `${width}x${height}`;
  return { value, label: `${edge / 1024}K · ${w}:${h} · ${width}×${height}` };
}));
export const LEGACY_GROK_SIZES = ["1024x1024", "1792x1024", "1024x1792", "1280x720", "720x1280"];
export function restrictedImageSizes(model: string): string[] | null {
  return ["grok-imagine-image", "grok-imagine-image-edit"].includes(model.toLowerCase()) ? LEGACY_GROK_SIZES : null;
}
export function validImageSize(value: string): boolean {
  if (value === "auto") return true;
  if (!/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(value)) return false;
  return value.split("x").every(part => Number(part) <= 65535);
}
export function imageSizeAllowed(model: string, value: string): boolean {
  return validImageSize(value) && (value === "auto" || !restrictedImageSizes(model) || restrictedImageSizes(model)!.includes(value));
}
export function imageSizeOptions(model: string) {
  // Presets select request parameters, not verified provider capabilities.
  return restrictedImageSizes(model)?.map(value => ({ value, label: value.replace("x", "×") })) || IMAGE_SIZE_PRESETS;
}
