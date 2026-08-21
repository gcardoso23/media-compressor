import type { ImageFormat, Resize, VideoCodec, VideoFormat } from './types.ts';
import { fitSize } from './utils/size.ts';

// How much work compressing something is, in seconds on the machine these
// numbers were measured on (an Apple M1 Pro). Only the proportions matter for
// progress: the interface measures the real speed as it goes and scales.
// Free of Node imports, so the interface uses it too.

// What is known about a file before compressing it.
export interface MediaInfo {
  width: number;
  height: number;
  // animation frames for images, total frames for videos
  frames: number;
  // seconds, videos only
  duration?: number;
}

// Source formats with no compression artefacts of their own.
const CLEAN = new Set(['png', 'gif', 'tif', 'tiff']);

// Seconds per megapixel, by output format, for sources that are already lossy
// (JPEG, WebP, AVIF) and for clean ones (PNG, GIF, TIFF).
const IMAGE: Record<'exact' | 'lossy', Record<'lossy' | 'clean', Record<ImageFormat | 'repack', number>>> = {
  exact: {
    // a pixel-exact WebP or AVIF of a lossy source is ruled out by a quick encode
    lossy: { repack: 0.025, jpeg: 0.06, png: 0.2, webp: 0.13, avif: 0.05, gif: 0.3 },
    clean: { repack: 0.2, jpeg: 0.06, png: 0.2, webp: 0.7, avif: 1.2, gif: 0.3 },
  },
  lossy: {
    lossy: { repack: 0.05, jpeg: 0.05, png: 0.3, webp: 0.12, avif: 0.2, gif: 0.3 },
    // WebP of a clean source also tries lossless, and keeps the smaller
    clean: { repack: 0.3, jpeg: 0.05, png: 0.3, webp: 0.62, avif: 0.14, gif: 0.3 },
  },
};

// fixed cost of reading, decoding and checking one file
const IMAGE_BASE = 0.05;

// Seconds per megapixel-frame of video.
const VIDEO: Record<VideoCodec | 'vmaf', number> = {
  h264: 0.012,
  // both passes together
  vp9: 0.066,
  av1: 0.008,
  vmaf: 0.0085,
};
const VIDEO_BASE = 0.3;
const POSTER = 0.3;

// the first VP9 pass only gathers statistics: under a tenth of the work
export const VP9_FIRST_PASS = 0.07;

const extension = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const megapixels = ({ width, height }: { width: number; height: number }) => (width * height) / 1e6;
const scaled = (media: MediaInfo, resize: Partial<Resize>) => fitSize(media, resize) ?? media;

// The cost of one output of an image, in reference seconds.
export function imageOutputCost(name: string, media: MediaInfo, format: ImageFormat | 'svg', exact: boolean, resize: Partial<Resize> = {}) {
  if (format === 'svg') return IMAGE_BASE;
  const source = extension(name);
  const table = IMAGE[exact ? 'exact' : 'lossy'][CLEAN.has(source) ? 'clean' : 'lossy'];
  const native = format === (source === 'jpg' ? 'jpeg' : source);
  const pixels = megapixels(scaled(media, resize)) * media.frames;
  return IMAGE_BASE + pixels * (native ? table.repack : table[format]);
}

export interface ImageWork {
  formats: (ImageFormat | 'original')[];
  lossy: boolean;
  resize?: Partial<Resize>;
}

// The cost of compressing a whole image with these settings.
export function imageCost(name: string, media: MediaInfo, { formats, lossy, resize = {} }: ImageWork): number {
  if (extension(name) === 'svg') return IMAGE_BASE;
  const source = extension(name);
  const native: ImageFormat = source === 'jpg' || source === 'jpeg' ? 'jpeg' : CLEAN.has(source) ? 'png' : (source as ImageFormat);
  const outputs = new Set(formats.map((format) => (format === 'original' ? native : format)));
  let total = 0;
  for (const format of outputs) total += imageOutputCost(name, media, format, !lossy, resize);
  return total;
}

// The cost of each step of one video output: its encoding passes, then the quality check.
export function videoStepCosts(media: MediaInfo, codec: VideoCodec, resize: Partial<Resize> = {}) {
  const work = megapixels(scaled(media, resize)) * media.frames;
  const encode = VIDEO_BASE + work * VIDEO[codec];
  return {
    passes: codec === 'vp9' ? [encode * VP9_FIRST_PASS, encode * (1 - VP9_FIRST_PASS)] : [encode],
    // scored against the source, at the encoded size
    vmaf: work * VIDEO.vmaf,
  };
}

export interface VideoWork {
  formats: VideoFormat[];
  webmCodec: 'vp9' | 'av1';
  check: boolean;
  poster?: boolean;
  resize?: Partial<Resize>;
}

// The cost of compressing a whole video with these settings, assuming the
// first encode holds quality (a retry adds to it as it happens).
export function videoCost(media: MediaInfo, { formats, webmCodec, check, poster = false, resize = {} }: VideoWork): number {
  let total = poster ? POSTER : 0;
  for (const format of formats) {
    const steps = videoStepCosts(media, format === 'mp4' ? 'h264' : webmCodec, resize);
    total += steps.passes.reduce((sum, cost) => sum + cost, 0) + (check ? steps.vmaf : 0);
  }
  return total;
}
