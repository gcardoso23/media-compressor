// Types shared by the engine, the folder scripts, the server and the interface.
// Kept free of Node imports so the browser code can use them too.

export type MediaKind = 'image' | 'video';

export type RequestedImageFormat = 'original' | 'jpeg' | 'png' | 'webp' | 'avif';
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif';
export type VideoFormat = 'mp4' | 'webm';
export type OutputFormat = ImageFormat | 'svg' | VideoFormat;
export type WebmCodec = 'vp9' | 'av1';
export type VideoCodec = 'h264' | WebmCodec;

export interface Resize {
  maxSize: number;
  width: number;
  height: number;
  scale: number;
}

export interface ImageSettings {
  formats: RequestedImageFormat[];
  lossy: boolean;
  resize: Resize;
  widths: number[];
  keepMetadata: boolean;
  background: string;
  reencodeQuality: number;
  jpeg: { quality: number };
  png: { quality: number; dither: number; effort: number };
  webp: { quality: number; effort: number };
  avif: { quality: number; effort: number };
  gif: { effort: number };
}

export interface VideoSettings {
  formats: VideoFormat[];
  webmCodec: WebmCodec;
  resize: Resize;
  fps: number;
  audio: boolean;
  quality: { check: boolean; maxLoss: number; attempts: number; crfStep: number };
  h264: { crf: number; preset: string; audioBitrate: string };
  vp9: { crf: number; twoPass: boolean; cpuUsed: number; audioBitrate: string };
  av1: { crf: number; preset: number; audioBitrate: string };
  poster: boolean;
  posterAt: number;
  posterFormat: 'jpg' | 'jpeg' | 'webp' | 'avif';
  posterQuality: number;
}

export interface Config {
  input: string;
  output: string;
  skipLarger: boolean;
  images: ImageSettings;
  videos: VideoSettings;
}

// What one source image needs: its settings plus the run-wide skip rule.
export type ImageOptions = ImageSettings & { skipLarger: boolean };

export interface PlannedOutput {
  format: OutputFormat;
  path: string;
  // the source's own format, written under its original file name
  native?: boolean;
  // a responsive variant at this width
  width?: number;
}

export interface Job {
  kind: MediaKind;
  source: string;
  rel: string;
  outputs: PlannedOutput[];
  poster?: string | null;
}

interface ResultBase {
  output: string;
  format: OutputFormat | 'poster';
}

// A file that was written.
export interface Written extends ResultBase {
  skipped?: undefined;
  bytes: number;
  native?: boolean;
  width?: number;
  height?: number;
  // the same pixels (or video streams) as the source
  exact: boolean;
  note?: string;
  vmaf?: number;
  // what a perfect copy of the footage scores, when that is below 100
  vmafCeiling?: number;
}

// An output that was deliberately not written, and why.
export interface Skipped extends ResultBase {
  skipped: string;
  // 'lossy': visually lossless mode would have produced one
  tip?: 'lossy';
}

export type Result = Written | Skipped;

export const isSkipped = (result: { skipped?: string }): result is Skipped => result.skipped !== undefined;

export interface Outcome {
  sourceBytes: number;
  results: Result[];
  warnings?: string[];
}

export interface Progress {
  format: string;
  stage: string;
  // how far the current stage is
  ratio: number;
  // how far the whole file is, all outputs and stages together
  overall: number;
  // the file's work as now known, against what was planned: 1 until a quality
  // retry adds encodes
  scale: number;
}
