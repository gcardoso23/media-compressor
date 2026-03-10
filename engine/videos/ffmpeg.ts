import { type RunOptions, type RunResult, isMissing, run } from '../utils/exec.ts';

async function exec(bin: string, args: string[], options?: RunOptions): Promise<RunResult> {
  try {
    return await run(bin, args, options);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`${bin} is not installed or not in PATH. Install it with: brew install ffmpeg`);
    }
    throw error;
  }
}

// Runs ffmpeg. `onProgress` is called with the position in seconds, and
// expects `-progress pipe:1` among the arguments.
export function ffmpeg(
  args: string[],
  { onProgress, cwd, signal }: { onProgress?: (seconds: number) => void; cwd?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const onStdout =
    onProgress &&
    ((chunk: Buffer) => {
      for (const match of chunk.toString().matchAll(/out_time_us=(\d+)\n/g)) onProgress(Number(match[1]) / 1e6);
    });
  return exec('ffmpeg', args, { onStdout, cwd, signal });
}

let filters: string | undefined;

export async function hasFilter(name: string): Promise<boolean> {
  filters ??= (await ffmpeg(['-hide_banner', '-filters'])).stdout.toString();
  return new RegExp(`^ \\S+ +${name} `, 'm').test(filters);
}

export interface VideoInfo {
  // as displayed, after any rotation flag
  width: number;
  height: number;
  rotated: boolean;
  duration: number;
  bytes: number;
  fps: number;
  codec: string;
  pixFmt: string;
  alpha: boolean;
  hdr: boolean;
  audio: { codec: string; channels: number } | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
  duration?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
}

const ALPHA_PIX_FMT = /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d)/;
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

export async function probe(file: string): Promise<VideoInfo> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const { streams = [], format = {} } = JSON.parse(stdout.toString()) as {
    streams?: ProbeStream[];
    format?: { duration?: string; size?: string };
  };
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) throw new Error('No video stream found');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  // phone footage is stored sideways with a rotation flag; ffmpeg applies it on decode
  const rotation = Number(video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;
  const [num = 0, den = 0] = (video.avg_frame_rate ?? '0/1').split('/').map(Number);
  const width = video.width ?? 0;
  const height = video.height ?? 0;

  return {
    width: sideways ? height : width,
    height: sideways ? width : height,
    rotated: rotation !== 0,
    duration: Number(format.duration) || Number(video.duration) || 0,
    bytes: Number(format.size) || 0,
    fps: den ? num / den : 0,
    codec: video.codec_name ?? '',
    pixFmt: video.pix_fmt ?? '',
    alpha: ALPHA_PIX_FMT.test(video.pix_fmt ?? ''),
    hdr: HDR_TRANSFERS.has(video.color_transfer ?? ''),
    audio: audio ? { codec: audio.codec_name ?? '', channels: audio.channels ?? 2 } : null,
  };
}
