import type { OutputInfo, Sharp } from 'sharp';
import type { ImageFormat, ImageOptions } from '../types.ts';

// Sources with no compression artefacts of their own, where lossless WebP is worth trying.
const CLEAN_SOURCES = new Set(['png', 'gif', 'tiff']);

export interface LossyResult {
  data: Buffer;
  info: OutputInfo;
  note?: string;
}

const toBuffer = (image: Sharp): Promise<LossyResult> => image.toBuffer({ resolveWithObject: true });

// Visually lossless encoding, the trade TinyPNG makes: no difference you can
// see at 100% zoom, but not pixel-exact. Only used in visually lossless mode.
export async function encodeLossy(
  image: Sharp,
  format: ImageFormat,
  { images, hasAlpha, sourceFormat }: { images: ImageOptions; hasAlpha: boolean; sourceFormat: string },
): Promise<LossyResult> {
  switch (format) {
    case 'jpeg': {
      const flat = hasAlpha ? image.flatten({ background: images.background }) : image;
      return toBuffer(flat.jpeg({ quality: images.jpeg.quality, mozjpeg: true }));
    }
    case 'png':
      // smart 256-colour palette with dithering
      return toBuffer(image.png({ palette: true, ...images.png }));
    case 'webp': {
      const lossy = () => toBuffer(image.clone().webp({ ...images.webp, smartSubsample: true }));
      if (!CLEAN_SOURCES.has(sourceFormat)) return lossy();
      // flat graphics and screenshots are often smaller as lossless WebP
      const [a, b] = await Promise.all([lossy(), toBuffer(image.clone().webp({ lossless: true, effort: images.webp.effort }))]);
      return b.data.length < a.data.length ? { ...b, note: 'lossless' } : a;
    }
    case 'avif':
      return toBuffer(image.avif(images.avif));
    case 'gif':
      return toBuffer(image.gif(images.gif));
  }
}
