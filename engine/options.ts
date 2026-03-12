import type { ParseArgsOptionsConfig } from 'node:util';
import { IMAGE_FORMATS, VIDEO_FORMATS } from './plan.ts';
import type { Config, RequestedImageFormat, Resize, VideoFormat } from './types.ts';

// Shared by the folder scripts and the interface: both describe a run with
// the same set of flags.
export const OPTIONS = {
  out: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  webp: { type: 'boolean' },
  avif: { type: 'boolean' },
  webm: { type: 'boolean' },
  'max-size': { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  scale: { type: 'string' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h' },

  lossy: { type: 'boolean' },
  quality: { type: 'string', short: 'q' },
  widths: { type: 'string' },
  'keep-metadata': { type: 'boolean' },

  crf: { type: 'string' },
  'webm-crf': { type: 'string' },
  av1: { type: 'boolean' },
  fps: { type: 'string' },
  'no-audio': { type: 'boolean' },
  'max-loss': { type: 'string' },
  'no-quality-check': { type: 'boolean' },
  poster: { type: 'boolean' },
  'poster-at': { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

export type FlagName = keyof typeof OPTIONS;
export type Flags = {
  [K in FlagName]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

function number(
  value: string | undefined,
  flag: string,
  { min = 0, max = Infinity, integer = true }: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    const range = max === Infinity ? `${min} or more` : `between ${min} and ${max}`;
    throw new Error(`--${flag} expects a${integer ? ' whole' : ''} number ${range}, got "${value}"`);
  }
  return parsed;
}

function assertFormats<T extends string>(formats: string[], allowed: readonly T[], label: string): asserts formats is T[] {
  const unknown = formats.filter((format) => !allowed.includes(format as T));
  if (unknown.length) {
    throw new Error(`Unknown ${label} format: ${unknown.join(', ')}. Use ${allowed.join(', ')}.`);
  }
}

const isImageFormat = (format: string): format is RequestedImageFormat =>
  (IMAGE_FORMATS as readonly string[]).includes(format);
const isVideoFormat = (format: string): format is VideoFormat => (VIDEO_FORMATS as readonly string[]).includes(format);

// Layers a set of flags over the loaded config.
export function applyFlags(config: Config, values: Flags): Config {
  const { images, videos } = config;
  if (values.out) config.output = values.out;

  const requested = list(values.format).map((format) => (format === 'jpg' ? 'jpeg' : format));
  assertFormats(requested, [...IMAGE_FORMATS, ...VIDEO_FORMATS], 'output');
  const imageFormats = requested.filter(isImageFormat);
  const videoFormats = requested.filter(isVideoFormat);
  if (imageFormats.length) images.formats = imageFormats;
  if (videoFormats.length) videos.formats = videoFormats;
  if (values.webp && !images.formats.includes('webp')) images.formats.push('webp');
  if (values.avif && !images.formats.includes('avif')) images.formats.push('avif');
  if (values.webm && !videos.formats.includes('webm')) videos.formats.push('webm');
  assertFormats(images.formats, IMAGE_FORMATS, 'image');
  assertFormats(videos.formats, VIDEO_FORMATS, 'video');

  const resize: Partial<Resize> = {
    maxSize: number(values['max-size'], 'max-size', { min: 1 }),
    width: number(values.width, 'width', { min: 1 }),
    height: number(values.height, 'height', { min: 1 }),
    scale: number(values.scale, 'scale', { min: 1, max: 100, integer: false }),
  };
  for (const key of Object.keys(resize) as (keyof Resize)[]) {
    const value = resize[key];
    if (value !== undefined) images.resize[key] = videos.resize[key] = value;
  }

  if (values.lossy) images.lossy = true;
  const quality = number(values.quality, 'quality', { min: 1, max: 100 });
  if (quality !== undefined) {
    if (!images.lossy) throw new Error('--quality only applies with --lossy: without it, images are compressed pixel-exact');
    images.jpeg.quality = images.webp.quality = quality;
  }
  if (values['keep-metadata']) images.keepMetadata = true;
  if (values.widths !== undefined) {
    images.widths = list(values.widths).map((width) => number(width, 'widths', { min: 1 }) as number);
  }

  if (values.av1) videos.webmCodec = 'av1';
  const crf = number(values.crf, 'crf', { max: 51 });
  if (crf !== undefined) videos.h264.crf = crf;
  const webmCrf = number(values['webm-crf'], 'webm-crf', { max: 63 });
  if (webmCrf !== undefined) videos[videos.webmCodec].crf = webmCrf;
  const fps = number(values.fps, 'fps', { min: 1, integer: false });
  if (fps !== undefined) videos.fps = fps;
  if (values['no-audio']) videos.audio = false;
  const maxLoss = number(values['max-loss'], 'max-loss', { max: 100, integer: false });
  if (maxLoss !== undefined) videos.quality.maxLoss = maxLoss;
  if (values['no-quality-check']) videos.quality.check = false;
  if (values.poster || values['poster-at'] !== undefined) videos.poster = true;
  const posterAt = number(values['poster-at'], 'poster-at', { integer: false });
  if (posterAt !== undefined) videos.posterAt = posterAt;

  return config;
}
