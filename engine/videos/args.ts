import os from 'node:os';
import type { Resize, VideoCodec, VideoFormat, VideoSettings } from '../types.ts';
import { fitSize } from '../utils/size.ts';
import type { VideoInfo } from './ffmpeg.ts';

// The settings that decide what happens to the picture.
export interface PictureSettings {
  fps: number;
  resize: Partial<Resize>;
}

// HDR (HLG / PQ) footage looks washed out when its values are read as SDR,
// so it is tone-mapped down to BT.709.
const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

const HEAD = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-progress', 'pipe:1', '-y'];
const STREAMS = ['-map', '0:v:0', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1'];

// What the picture goes through before it reaches the encoder. `changed` is
// false when every frame is passed on exactly as decoded.
export function pictureFilters(info: VideoInfo, videos: PictureSettings): { filters: string[]; changed: boolean } {
  const filters: string[] = [];
  if (videos.fps > 0 && info.fps > videos.fps + 0.01) filters.push(`fps=${videos.fps}`);

  // 4:2:0 encoders need even dimensions: scaled sizes are rounded to them,
  // and an odd-sized source loses its last row / column instead of being resampled
  const fitted = fitSize(info, videos.resize);
  if (fitted) {
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    filters.push(`scale=${even(fitted.width)}:${even(fitted.height)}:flags=lanczos`);
  } else if (info.width % 2 || info.height % 2) {
    filters.push(`crop=${info.width - (info.width % 2)}:${info.height - (info.height % 2)}:0:0`);
  }

  if (info.hdr) filters.push(TONEMAP);
  return { filters, changed: filters.length > 0 };
}

function audioArgs(info: VideoInfo, videos: VideoSettings, codec: string, bitrate: string): string[] {
  if (!videos.audio || !info.audio) return ['-an'];
  // surround is downmixed: web players are stereo and libopus rejects some 5.1 layouts
  const downmix = info.audio.channels > 2 ? ['-ac', '2'] : [];
  return ['-map', '0:a:0', '-c:a', codec, '-b:a', bitrate, ...downmix];
}

export interface PassOptions {
  source: string;
  target: string;
  codec: VideoCodec;
  crf: number;
  info: VideoInfo;
  videos: VideoSettings;
  passlog: string;
}

// One argument list per ffmpeg invocation needed to produce `target`.
export function buildPasses({ source, target, codec, crf, info, videos, passlog }: PassOptions): string[][] {
  const alpha = info.alpha && codec === 'vp9';
  const chain = [...pictureFilters(info, videos).filters, `format=${alpha ? 'yuva420p' : 'yuv420p'}`];
  const input = [...HEAD, '-i', source, ...STREAMS, '-vf', chain.join(',')];

  if (codec === 'h264') {
    const { preset, audioBitrate } = videos.h264;
    return [[
      ...input,
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high',
      // moves the index to the front so playback starts before the download finishes
      '-movflags', '+faststart',
      ...audioArgs(info, videos, 'aac', audioBitrate),
      target,
    ]];
  }

  if (codec === 'av1') {
    const { preset, audioBitrate } = videos.av1;
    return [[
      ...input,
      '-c:v', 'libsvtav1', '-preset', String(preset), '-crf', String(crf), '-g', '240',
      ...audioArgs(info, videos, 'libopus', audioBitrate),
      target,
    ]];
  }

  const { twoPass, cpuUsed, audioBitrate } = videos.vp9;
  const vp9 = [
    // -b:v 0 switches libvpx to pure constant-quality mode
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-g', '240',
    '-row-mt', '1', '-tile-columns', '2', '-deadline', 'good',
    // alt-ref frames break the alpha plane in libvpx
    '-auto-alt-ref', alpha ? '0' : '1', '-lag-in-frames', '25',
  ];
  const audio = audioArgs(info, videos, 'libopus', audioBitrate);
  if (!twoPass) return [[...input, ...vp9, '-cpu-used', String(cpuUsed), ...audio, target]];
  return [
    [...input, ...vp9, '-cpu-used', '4', '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'null', '-'],
    [...input, ...vp9, '-cpu-used', String(cpuUsed), '-pass', '2', '-passlogfile', passlog, ...audio, target],
  ];
}

// Streams that browsers play as they are, per container.
const COPY_SAFE: Record<VideoFormat, { video: string[]; audio: string[] }> = {
  mp4: { video: ['h264'], audio: ['aac', 'mp3'] },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
};

// True when the source can go into `format` without being re-encoded at all.
// A rotation flag is fine: it travels with the copied stream.
export function canCopy(format: VideoFormat, info: VideoInfo, videos: PictureSettings & { audio: boolean }): boolean {
  const safe = COPY_SAFE[format];
  if (pictureFilters(info, videos).changed || info.alpha) return false;
  if (!safe.video.includes(info.codec) || !['yuv420p', 'yuvj420p'].includes(info.pixFmt)) return false;
  return !videos.audio || !info.audio || safe.audio.includes(info.audio.codec);
}

// Repackages the source streams bit for bit: no quality change at all.
export function copyArgs({
  source,
  target,
  format,
  info,
  videos,
}: {
  source: string;
  target: string;
  format: VideoFormat;
  info: VideoInfo;
  videos: VideoSettings;
}): string[] {
  return [
    ...HEAD, '-i', source, ...STREAMS,
    ...(videos.audio && info.audio ? ['-map', '0:a:0'] : ['-an']),
    '-c', 'copy',
    ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
    target,
  ];
}

// Scores `encoded` against the source put through the same filters, so only
// the loss added by the encoder is measured. Without `encoded` the source is
// scored against itself, which gives the best score this footage can reach.
export function vmafArgs({
  source,
  encoded,
  info,
  videos,
  fps,
}: {
  source: string;
  encoded?: string;
  info: VideoInfo;
  videos: VideoSettings;
  fps: number;
}): string[] {
  // Frames are paired by index on one shared timebase. Pairing by timestamp
  // goes off by one, because WebM rounds its timestamps to whole milliseconds.
  const retime = `settb=AVTB,setpts=N/(${fps}*TB)`;
  const reference = [...pictureFilters(info, videos).filters, 'format=yuv420p', retime].join(',');
  const graph = [
    `[0:v]${encoded ? `format=yuv420p,${retime}` : reference}[distorted]`,
    `[1:v]${reference}[reference]`,
    `[distorted][reference]libvmaf=n_threads=${os.availableParallelism()}:log_fmt=json:log_path=vmaf.json`,
  ].join(';');
  return [...HEAD, '-i', encoded ?? source, '-i', source, '-lavfi', graph, '-f', 'null', '-'];
}

// A single frame as PNG on stdout, at the same size the video is encoded at.
export function posterArgs({ source, info, videos }: { source: string; info: VideoInfo; videos: VideoSettings }): string[] {
  const { filters } = pictureFilters(info, { ...videos, fps: 0 });
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(videos.posterAt), '-i', source,
    '-map', '0:v:0', '-frames:v', '1',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
  ];
}
