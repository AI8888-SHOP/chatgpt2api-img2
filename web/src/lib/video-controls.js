/** @param {import('./api').VideoModelConfig | undefined} model
 * @param {string} mode
 * @param {boolean} frameMode */
export function referenceLimit(model, mode, frameMode) {
  if (mode === "image") return 1;
  if (model?.protocol === "image2pro" && model.supports_frame_control && (frameMode || model.supports_reference_images === false)) return 2;
  return model?.max_reference_images || 0;
}

/** @param {import('./api').VideoModelConfig} model
 * @param {number} current
 * @param {number} maximum */
export function allowedDuration(model, current, maximum) {
  if (model.durations?.length) return model.durations.includes(current) ? current : model.duration_default || model.durations[0];
  return Math.max(model.min_duration, Math.min(current, maximum));
}
