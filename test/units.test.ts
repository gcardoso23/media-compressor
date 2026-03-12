import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { hasRedundantProfile } from '../engine/images/icc.ts';
import { countColours, isOpaque, samePixels } from '../engine/images/pixels.ts';
import { planJobs } from '../engine/plan.ts';
import type { Config, Job, MediaKind } from '../engine/types.ts';
import { fitSize } from '../engine/utils/size.ts';
import { canCopy, pictureFilters } from '../engine/videos/args.ts';
import type { VideoInfo } from '../engine/videos/ffmpeg.ts';
import { configWith } from './helpers.ts';

const OUT = path.resolve('/out');
const plan = (files: string[], config: Config = configWith(), kinds: MediaKind[] = ['image', 'video']) =>
  planJobs(
    files.map((file) => ({ file: path.resolve('/in', file), rel: file })),
    { outDir: OUT, config, kinds },
  );
const names = (job: Job | undefined) => (job?.outputs ?? []).map((output) => path.relative(OUT, output.path));

test('fitSize keeps the aspect ratio and never enlarges', () => {
  const source = { width: 4000, height: 3000 };
  assert.deepEqual(fitSize(source, { maxSize: 2000 }), { width: 2000, height: 1500 });
  assert.deepEqual(fitSize({ width: 3000, height: 4000 }, { maxSize: 2000 }), { width: 1500, height: 2000 });
  assert.deepEqual(fitSize(source, { width: 1000 }), { width: 1000, height: 750 });
  assert.deepEqual(fitSize(source, { height: 300 }), { width: 400, height: 300 });
  assert.deepEqual(fitSize(source, { scale: 50 }), { width: 2000, height: 1500 });
  assert.equal(fitSize(source, { maxSize: 8000 }), null);
  assert.equal(fitSize(source, { width: 4000 }), null);
  assert.equal(fitSize(source, {}), null);
});

test('fitSize applies the strictest limit when several are set', () => {
  const source = { width: 4000, height: 3000 };
  assert.deepEqual(fitSize(source, { width: 2000, height: 300 }), { width: 400, height: 300 });
  assert.deepEqual(fitSize(source, { scale: 50, maxSize: 1000 }), { width: 1000, height: 750 });
});

test('samePixels only forgives colour hidden under full transparency', () => {
  const visible = Buffer.from([10, 20, 30, 255, 1, 2, 3, 0]);
  assert.ok(samePixels(visible, Buffer.from([10, 20, 30, 255, 9, 9, 9, 0])));
  assert.ok(!samePixels(visible, Buffer.from([10, 20, 31, 255, 1, 2, 3, 0])));
  assert.ok(!samePixels(visible, Buffer.from([10, 20, 30, 254, 1, 2, 3, 0])));
  assert.ok(!samePixels(visible, Buffer.from([10, 20, 30, 255, 1, 2, 3, 1])));
  assert.ok(!samePixels(visible, visible.subarray(0, 4)));
});

test('samePixels compares 16-bit samples in full', () => {
  const pixel = Buffer.from([0, 1, 0, 2, 0, 3, 255, 255]);
  assert.ok(samePixels(pixel, Buffer.from(pixel), true));
  assert.ok(!samePixels(pixel, Buffer.from([1, 1, 0, 2, 0, 3, 255, 255]), true));
});

test('isOpaque and countColours', () => {
  assert.ok(isOpaque(Buffer.from([1, 2, 3, 255, 4, 5, 6, 255])));
  assert.ok(!isOpaque(Buffer.from([1, 2, 3, 255, 4, 5, 6, 254])));
  assert.equal(countColours(Buffer.from([1, 2, 3, 255, 1, 2, 3, 255, 9, 9, 9, 255])), 2);
  const many = Buffer.alloc(300 * 4);
  for (let i = 0; i < 300; i++) many.writeUInt32LE(i, i * 4);
  assert.ok(countColours(many) > 256);
});

test('only a standard sRGB profile counts as redundant', () => {
  const profile = (name: string) => {
    const text = Buffer.from(`${name}\0`, 'latin1');
    const icc = Buffer.alloc(144 + 12 + text.length);
    icc.writeUInt32BE(1, 128);
    icc.write('desc', 132, 'latin1');
    icc.writeUInt32BE(144, 136);
    icc.write('desc', 144, 'latin1');
    icc.writeUInt32BE(text.length, 152);
    text.copy(icc, 156);
    return icc;
  };
  assert.ok(hasRedundantProfile(profile('sRGB IEC61966-2.1')));
  assert.ok(!hasRedundantProfile(profile('Display P3')));
  assert.ok(!hasRedundantProfile(profile('sRGB-elle-V2-g22')));
  assert.ok(!hasRedundantProfile(undefined));
});

test('original keeps the exact file name, conversions swap the extension', () => {
  const [job] = plan(['photos/Hero.JPEG'], configWith({ images: { formats: ['original', 'webp', 'avif'] } }));
  assert.deepEqual(names(job), ['photos/Hero.JPEG', 'photos/Hero.webp', 'photos/Hero.avif']);
  assert.deepEqual(
    job.outputs.map((output) => output.native),
    [true, false, false],
  );
});

test('sources that would collide on one output name stay apart', () => {
  const jobs = plan(['hero.jpg', 'hero.png'], configWith({ images: { formats: ['webp'] } }));
  assert.deepEqual(jobs.flatMap(names), ['hero.webp', 'hero.png.webp']);
});

test('an output is never allowed to overwrite its source', () => {
  const config = configWith();
  const sources = [{ file: path.join(OUT, 'a.png'), rel: 'a.png' }];
  assert.throws(() => planJobs(sources, { outDir: OUT, config, kinds: ['image'] }), /overwrite its source/);
});

test('TIFF becomes PNG, or JPEG once lossy output is allowed', () => {
  assert.deepEqual(names(plan(['scan.tiff'])[0]), ['scan.png']);
  assert.deepEqual(names(plan(['scan.tiff'], configWith({ images: { lossy: true } }))[0]), ['scan.jpg']);
});

test('SVG is only ever optimised as SVG', () => {
  const [job] = plan(['icon.svg'], configWith({ images: { formats: ['webp', 'avif'] } }));
  assert.deepEqual(names(job), ['icon.svg']);
});

test('responsive widths get their own files per format', () => {
  const [job] = plan(['a.png'], configWith({ images: { formats: ['original', 'webp'], widths: [640] } }));
  assert.deepEqual(names(job), ['a.png', 'a-640w.png', 'a.webp', 'a-640w.webp']);
});

test('videos map to mp4 / webm plus an optional poster', () => {
  const config = configWith({ videos: { formats: ['mp4', 'webm'], poster: true } });
  const [job] = plan(['clips/intro.mov', 'notes.txt'], config);
  assert.deepEqual(names(job), ['clips/intro.mp4', 'clips/intro.webm']);
  assert.equal(path.relative(OUT, job?.poster ?? ''), 'clips/intro-poster.jpg');
  assert.equal(plan(['clips/intro.mov'], config, ['image']).length, 0);
});

const info: VideoInfo = {
  width: 1920,
  height: 1080,
  rotated: false,
  duration: 10,
  bytes: 1e7,
  fps: 30,
  codec: 'h264',
  pixFmt: 'yuv420p',
  alpha: false,
  hdr: false,
  audio: { codec: 'aac', channels: 2 },
};

test('video frames are only filtered when something has to change', () => {
  const { videos } = configWith();
  assert.deepEqual(pictureFilters(info, videos), { filters: [], changed: false });
  // odd sizes lose a row / column instead of being resampled
  assert.deepEqual(pictureFilters({ ...info, width: 853, height: 479 }, videos).filters, ['crop=852:478:0:0']);
  const scaled = pictureFilters(info, { ...videos, resize: { maxSize: 1280 } });
  assert.deepEqual(scaled.filters, ['scale=1280:720:flags=lanczos']);
  // 1365.33 wide would be odd: scaled sizes are rounded to even
  const odd = pictureFilters({ ...info, width: 2048, height: 1080 }, { ...videos, resize: { height: 720 } });
  assert.deepEqual(odd.filters, ['scale=1366:720:flags=lanczos']);
  assert.deepEqual(pictureFilters({ ...info, fps: 60 }, { ...videos, fps: 30 }).filters, ['fps=30']);
  assert.deepEqual(pictureFilters(info, { ...videos, fps: 30 }).filters, []);
});

test('streams are only copied when browsers can play them untouched', () => {
  const { videos } = configWith();
  assert.ok(canCopy('mp4', info, videos));
  assert.ok(canCopy('mp4', { ...info, audio: null }, videos));
  assert.ok(!canCopy('webm', info, videos));
  assert.ok(canCopy('webm', { ...info, codec: 'vp9', audio: { codec: 'opus', channels: 2 } }, videos));
  assert.ok(!canCopy('mp4', { ...info, codec: 'hevc' }, videos));
  assert.ok(!canCopy('mp4', { ...info, pixFmt: 'yuv422p10le' }, videos));
  assert.ok(!canCopy('mp4', { ...info, audio: { codec: 'pcm_s16le', channels: 2 } }, videos));
  assert.ok(canCopy('mp4', { ...info, audio: { codec: 'pcm_s16le', channels: 2 } }, { ...videos, audio: false }));
  assert.ok(!canCopy('mp4', info, { ...videos, resize: { maxSize: 1280 } }));
});
