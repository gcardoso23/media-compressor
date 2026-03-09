import type { Resize } from '../types.ts';

export interface Size {
  width: number;
  height: number;
}

// Target size for a proportional downscale, or null when nothing has to change.
// Every limit is applied at once and the strictest one wins, so the aspect
// ratio is always kept and the result is never larger than the source.
export function fitSize({ width, height }: Size, limits: Partial<Resize> = {}): Size | null {
  const { maxSize = 0, width: maxWidth = 0, height: maxHeight = 0, scale = 0 } = limits;
  let ratio = 1;
  if (scale > 0) ratio = Math.min(ratio, scale / 100);
  if (maxSize > 0) ratio = Math.min(ratio, maxSize / Math.max(width, height));
  if (maxWidth > 0) ratio = Math.min(ratio, maxWidth / width);
  if (maxHeight > 0) ratio = Math.min(ratio, maxHeight / height);
  if (ratio >= 1) return null;

  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}
