import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Config, Job, Outcome, PlannedOutput, Progress, Result, VideoCodec, VideoFormat, VideoSettings } from '../types.ts';
import { type MediaInfo, videoStepCosts } from '../estimate.ts';
import { buildPasses, canCopy, copyArgs, posterArgs, vmafArgs } from './args.ts';
import { type VideoInfo, ffmpeg, hasFilter, probe } from './ffmpeg.ts';

const partials = new Set<string>();

const NAMES: Record<VideoFormat, string> = { mp4: 'MP4', webm: 'WebM' };

// Called on Ctrl-C so a half-written file is never mistaken for a finished one.
export function removePartials(): void {
  for (const file of partials) rmSync(file, { force: true, recursive: true });
}

async function writePoster(poster: string, job: Job, info: VideoInfo, videos: VideoSettings): Promise<Result> {
  const { stdout: frame } = await ffmpeg(posterArgs({ source: job.source, info, videos }));
  if (!frame.length) return { output: poster, format: 'poster', skipped: `no frame at ${videos.posterAt}s` };

  const quality = videos.posterQuality;
  let image = sharp(frame);
  if (videos.posterFormat === 'webp') image = image.webp({ quality, smartSubsample: true });
  else if (videos.posterFormat === 'avif') image = image.avif({ quality });
  else image = image.jpeg({ quality, mozjpeg: true });

  const { data, info: size } = await image.toBuffer({ resolveWithObject: true });
  await writeFile(poster, data);
  return { output: poster, format: 'poster', bytes: data.length, width: size.width, height: size.height, exact: false };
}

interface Quality {
  ok: boolean;
  exact?: boolean;
  vmaf?: number;
  vmafCeiling?: number;
}

// Encodes every planned output of one source video. `onProgress` reports
// which output and stage ffmpeg is on, while it runs.
export async function compressVideo(
  job: Job,
  config: Config,
  { onProgress, signal }: { onProgress?: (progress: Progress) => void; signal?: AbortSignal } = {},
): Promise<Outcome> {
  const { videos } = config;
  const { check, maxLoss, attempts, crfStep } = videos.quality;
  const info = await probe(job.source);
  const results: Result[] = [];
  const warnings: string[] = [];
  if (info.hdr) warnings.push('HDR source was tone-mapped to SDR');

  const measured = check && (await hasFilter('libvmaf'));
  if (check && !measured) warnings.push('quality was not measured: this ffmpeg build has no libvmaf');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'media-compressor-'));
  partials.add(tmp);

  // Progress over the whole file: every pass and quality check, of every
  // output, weighted by how long it takes. A retry adds its steps as it starts.
  const media: MediaInfo = { width: info.width, height: info.height, frames: Math.max(1, Math.round(info.duration * info.fps)) };
  const costsOf = (format: VideoFormat) => videoStepCosts(media, format === 'mp4' ? 'h264' : videos.webmCodec, videos.resize);
  const encodeCost = (format: VideoFormat) => costsOf(format).passes.reduce((sum, cost) => sum + cost, 0);
  const work = { done: 0, total: 0 };
  for (const out of job.outputs) {
    const format = out.format as VideoFormat;
    work.total += encodeCost(format) + (measured ? costsOf(format).vmaf : 0);
  }
  const planned = work.total;

  // Runs one ffmpeg step worth `cost`, reporting its progress and the file's.
  const step = async (args: string[], format: string, stage: string, cost: number, options: { cwd?: string } = {}) => {
    const report = (ratio: number) =>
      onProgress?.({
        format,
        stage,
        ratio,
        overall: Math.min(1, (work.done + cost * ratio) / work.total),
        scale: work.total / planned,
      });
    // announced up front: a first VP9 pass writes no packets, so it never reports a position
    report(0);
    await ffmpeg(args, {
      ...options,
      signal,
      onProgress: (seconds) => report(info.duration ? Math.min(1, seconds / info.duration) : 0),
    });
    work.done += cost;
  };

  // VMAF of `encoded` against the source, or of the source against itself.
  const score = async ({ encoded, fps, format, stage }: { encoded?: string; fps: number; format: VideoFormat; stage: string }) => {
    await step(vmafArgs({ source: job.source, encoded, info, videos, fps }), format, stage, costsOf(format).vmaf, { cwd: tmp });
    const log = JSON.parse(await readFile(path.join(tmp, 'vmaf.json'), 'utf8')) as {
      pooled_metrics: { vmaf: { mean: number } };
    };
    return log.pooled_metrics.vmaf.mean;
  };

  // The best score this footage can reach. Not always 100: footage with little
  // motion tops out lower even when nothing was changed. Measured on demand.
  let ceiling: number | undefined;

  const encode = async (out: PlannedOutput, codec: VideoCodec, crf: number, partial: string): Promise<Quality> => {
    const format = out.format as VideoFormat;
    const passes = buildPasses({ source: job.source, target: partial, codec, crf, info, videos, passlog: path.join(tmp, 'pass') });
    const planned = costsOf(format).passes;
    // a single-pass VP9 does all of its work in that one pass
    const costs = passes.length === planned.length ? planned : [encodeCost(format)];
    for (const [index, args] of passes.entries()) {
      const stage = passes.length > 1 ? `crf ${crf}, pass ${index + 1}/${passes.length}` : `crf ${crf}`;
      await step(args, format, stage, costs[index] ?? 0);
    }
    if (!measured) return { ok: true };

    const { fps } = await probe(partial);
    const vmaf = await score({ encoded: partial, fps, format, stage: 'measuring quality' });
    // close enough to 100 passes whatever the ceiling turns out to be
    if (vmaf >= 100 - maxLoss) return { ok: true, vmaf };
    if (ceiling === undefined) {
      work.total += costsOf(format).vmaf;
      ceiling = await score({ fps, format, stage: 'measuring the source' });
    }
    return { ok: vmaf >= ceiling - maxLoss, vmaf, vmafCeiling: ceiling };
  };

  try {
    // the smallest file that can stand in for the others: a WebM has to beat it
    const baseline = { bytes: info.bytes, name: 'source' };

    for (const out of job.outputs) {
      const format = out.format as VideoFormat;
      const codec: VideoCodec = format === 'mp4' ? 'h264' : videos.webmCodec;
      if (info.alpha && codec !== 'vp9') {
        warnings.push(`${NAMES[format]}: transparency dropped, only VP9 WebM keeps it`);
      }

      await mkdir(path.dirname(out.path), { recursive: true });
      // ffmpeg picks the container from the extension, so the temp name keeps it
      const ext = path.extname(out.path);
      const partial = `${out.path.slice(0, -ext.length)}.partial${ext}`;
      partials.add(partial);

      try {
        let crf = videos[codec].crf;
        let quality = await encode(out, codec, crf, partial);
        for (let attempt = 1; !quality.ok && attempt < attempts && crf > 0; attempt++) {
          crf = Math.max(0, crf - crfStep);
          work.total += encodeCost(format) + (measured ? costsOf(format).vmaf : 0);
          quality = await encode(out, codec, crf, partial);
        }

        let encoded = await probe(partial);
        let note = crf === videos[codec].crf ? undefined : `crf lowered to ${crf} to hold quality`;
        const copyable = canCopy(format, info, videos);

        // Re-encoding only pays when it is both smaller and faithful. When it
        // isn't, streams browsers already play are kept exactly as they are.
        if (copyable && (!quality.ok || encoded.bytes >= info.bytes)) {
          await ffmpeg(copyArgs({ source: job.source, target: partial, format, info, videos }), { signal });
          encoded = await probe(partial);
          note = quality.ok ? 'already optimal, streams copied untouched' : 'streams copied untouched, no encode held quality';
          quality = { ok: true, exact: true };
        } else if (!quality.ok) {
          const lost = ((quality.vmafCeiling ?? 100) - (quality.vmaf ?? 0)).toFixed(1);
          warnings.push(
            `${NAMES[format]}: still ${lost} VMAF points below a perfect copy at CRF ${crf}, more than the ${maxLoss} allowed. ` +
              'A lower starting CRF in media.config.ts keeps more detail.',
          );
        }

        if (format === 'webm' && config.skipLarger && encoded.bytes >= baseline.bytes) {
          results.push({ output: out.path, format, skipped: `webm is not smaller than the ${baseline.name}` });
          continue;
        }

        await rename(partial, out.path);
        if (encoded.bytes < baseline.bytes) Object.assign(baseline, { bytes: encoded.bytes, name: format });
        results.push({
          output: out.path,
          format,
          bytes: encoded.bytes,
          width: encoded.width,
          height: encoded.height,
          vmaf: quality.vmaf,
          vmafCeiling: quality.vmafCeiling,
          exact: Boolean(quality.exact),
          note,
        });
      } finally {
        await rm(partial, { force: true });
        partials.delete(partial);
      }
    }

    if (job.poster) results.push(await writePoster(job.poster, job, info, videos));
  } finally {
    await rm(tmp, { recursive: true, force: true });
    partials.delete(tmp);
  }

  return { sourceBytes: info.bytes, results, warnings };
}
