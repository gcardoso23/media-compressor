import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { compressImage } from './images/compress.ts';
import { type Flags, OPTIONS, applyFlags } from './options.ts';
import { planJobs } from './plan.ts';
import type { Job, MediaKind } from './types.ts';
import { collectSources } from './utils/fs.ts';
import { openManifest } from './utils/manifest.ts';
import { pool } from './utils/pool.ts';
import { createReporter } from './utils/report.ts';
import { compressVideo, removePartials } from './videos/compress.ts';
import { ffmpeg } from './videos/ffmpeg.ts';

// sharp is multi-threaded per image, ffmpeg per video, so videos run one at a time.
const IMAGE_CONCURRENCY = 4;

const COMMANDS: Record<string, MediaKind[]> = {
  images: ['image'],
  videos: ['video'],
  all: ['image', 'video'],
};

const HELP = `
npm run compress -- <images|videos|all> [paths...] [options]
(the interface is npm run dev)

  images   jpg, png, webp, avif, gif, tiff, svg
  videos   mp4, mov, m4v, mkv, webm, avi, mpg, wmv, ogv
  all      both

Paths are files or folders (default: ./input). Results are written to
./output with the same folder structure. Sources are never modified.

Images are compressed without changing a single pixel, and every output is
checked against its source before it is written. Videos are encoded at a
visually lossless quality and scored against their source with VMAF.

Options
  -o, --out <dir>        output directory (default: output)
  -f, --format <list>    write exactly these formats, comma separated
                         images: original, jpeg, png, webp, avif
                         videos: mp4, webm
      --webp             also write WebP
      --avif             also write AVIF
      --webm             also write WebM
      --force            redo files whose output is already up to date
      --dry-run          list what would be written
      --config <file>    extra config file (default: ./media.config.ts)
  -h, --help

Resize (proportional: keeps the aspect ratio, never enlarges)
      --max-size <px>    cap the longest edge
      --width <px>       cap the width
      --height <px>      cap the height
      --scale <percent>  scale to a percentage of the source, e.g. 50

Images
      --lossy            allow visually lossless compression (like TinyPNG):
                         much smaller, same look, but not the same pixels
  -q, --quality <1-100>  JPEG and WebP quality for --lossy (default: 85)
      --widths <list>    extra responsive widths, e.g. 640,1280
      --keep-metadata    keep EXIF and XMP (the colour profile is always kept)

Videos
      --crf <n>          H.264 quality, lower is better (default: 18)
      --webm-crf <n>     WebM quality, lower is better
      --max-loss <n>     VMAF points an encode may lose against a perfect copy
                         before it is redone at higher quality (default: 1)
      --no-quality-check skip the VMAF measurement
      --av1              encode WebM as AV1 instead of VP9
      --fps <n>          cap the frame rate
      --no-audio         drop the audio track
      --poster           also write a poster frame
      --poster-at <s>    poster timestamp in seconds (default: 0)
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    // node appends a long hint about positionals; the first sentence is the useful part
    throw new Error(`${(error as Error).message.split('. ')[0]}. Run with --help to see the options.`);
  }
  const { positionals } = parsed;
  const values: Flags = parsed.values;
  const [command, ...paths] = positionals;

  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const kinds = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!kinds) throw new Error(`Unknown command "${command}". Use images, videos or all.`);

  const config = applyFlags(await loadConfig(values.config), values);
  const outDir = path.resolve(config.output);
  const inputs = paths.length ? paths : [config.input];
  const jobs = planJobs(await collectSources(inputs, outDir), { outDir, config, kinds });

  if (!jobs.length) {
    console.log(`No ${command === 'all' ? 'images or videos' : command} found in ${inputs.join(', ')}`);
    return 0;
  }

  if (values['dry-run']) {
    for (const job of jobs) {
      console.log(job.rel);
      for (const output of job.outputs) console.log(`  → ${path.relative(outDir, output.path)}`);
      if (job.poster) console.log(`  → ${path.relative(outDir, job.poster)}`);
    }
    console.log(`\nWould write to ${outDir}`);
    return 0;
  }

  const reporter = createReporter();
  const images = { ...config.images, skipLarger: config.skipLarger };
  const videos = { ...config.videos, skipLarger: config.skipLarger };
  const manifest = await openManifest(outDir, { image: images, video: videos });
  const pending = async (job: Job) => {
    if (values.force || !(await manifest.isCurrent(job))) return true;
    reporter.upToDate(job);
    return false;
  };

  await pool(jobs.filter((job) => job.kind === 'image'), IMAGE_CONCURRENCY, async (job) => {
    try {
      if (!(await pending(job))) return;
      const { sourceBytes, results } = await compressImage(job, images);
      await manifest.record(job, results);
      reporter.done(job, sourceBytes, results);
    } catch (error) {
      reporter.failed(job, error);
    }
  });
  await manifest.save();

  const videoJobs = jobs.filter((job) => job.kind === 'video');
  if (videoJobs.length) {
    await ffmpeg(['-version']);
    process.once('SIGINT', () => {
      removePartials();
      process.exit(130);
    });
  }
  for (const job of videoJobs) {
    try {
      if (!(await pending(job))) continue;
      const { sourceBytes, results, warnings } = await compressVideo(job, config, {
        onProgress: (progress) => reporter.progress(job, progress),
      });
      // saved per video: an encode takes minutes, and a later one may be interrupted
      await manifest.record(job, results);
      await manifest.save();
      reporter.done(job, sourceBytes, results, warnings);
    } catch (error) {
      reporter.failed(job, error);
    }
  }

  reporter.summary(outDir);
  return reporter.counts.failed ? 1 : 0;
}
