import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { imageCost, videoCost } from '../engine/estimate.ts';
import { compressImage } from '../engine/images/compress.ts';
import type { MediaKind, Progress } from '../engine/types.ts';
import { compressVideo } from '../engine/videos/compress.ts';
import { measureRun, remaining } from '../lib/estimate.ts';
import type { Item } from '../lib/files.ts';
import { configWith, hasCommand, jobFor, photo, tmpDir } from './helpers.ts';
import { run } from '../engine/utils/exec.ts';

const PHOTO = { width: 4000, height: 3000, frames: 1 };

test('image cost follows the real work: pixels, formats and mode', () => {
  const repack = imageCost('a.jpg', PHOTO, { formats: ['original'], lossy: false });
  const exactAvif = imageCost('a.png', PHOTO, { formats: ['avif'], lossy: false });
  assert.ok(exactAvif > repack * 10, 'an exact AVIF of a PNG is far more work than repacking a JPEG');

  const both = imageCost('a.png', PHOTO, { formats: ['original', 'webp'], lossy: false });
  const one = imageCost('a.png', PHOTO, { formats: ['original'], lossy: false });
  assert.ok(both > one);

  const half = imageCost('a.png', PHOTO, { formats: ['original'], lossy: false, resize: { scale: 50 } });
  assert.ok(half < one / 2, 'a quarter of the pixels is much less work');
});

test('video cost follows duration, codecs and the quality check', () => {
  const clip = { width: 1920, height: 1080, frames: 240, duration: 10 };
  const mp4 = videoCost(clip, { formats: ['mp4'], webmCodec: 'vp9', check: false });
  const webm = videoCost(clip, { formats: ['webm'], webmCodec: 'vp9', check: false });
  const checked = videoCost(clip, { formats: ['mp4'], webmCodec: 'vp9', check: true });
  const longer = videoCost({ ...clip, frames: 480, duration: 20 }, { formats: ['mp4'], webmCodec: 'vp9', check: false });
  assert.ok(webm > mp4 * 3, 'two-pass VP9 takes several times longer than H.264');
  assert.ok(checked > mp4);
  assert.ok(longer > mp4 * 1.8);
});

test('time left starts from the learned speed and moves to the measured pace', () => {
  // nothing measured yet: the work left at the learned speed
  assert.equal(remaining({ done: 0, left: 60, elapsed: 2, rate: 1 }), 60);
  // a fifth or more done: purely the pace so far (10 s for a quarter leaves 30 s)
  assert.equal(remaining({ done: 25, left: 75, elapsed: 10, rate: 2 }), 30);
  // in between: a blend of the two
  assert.equal(remaining({ done: 10, left: 90, elapsed: 5, rate: 1 }), 67.5);
  assert.equal(remaining({ done: 10, left: 0, elapsed: 5, rate: 1 }), 0);
});

const item = (key: string, kind: MediaKind, rest: Partial<Item>): Item => ({
  key,
  file: new File([], key),
  name: key,
  bytes: 1,
  kind,
  vector: false,
  status: 'working',
  ...rest,
});

test('a run with videos is paced by its videos, which run one at a time', () => {
  const costs = { clip: 60, a: 5, b: 5 };
  const progress = (overall: number) => ({ format: 'mp4', stage: 'crf 18', ratio: 0, overall, scale: 1 });
  const items = [
    item('clip', 'video', { progress: progress(0.25), fraction: 0.25 }),
    item('a', 'image', { status: 'done' }),
    item('b', 'image', { status: 'done' }),
  ];
  const run = measureRun(items, costs);
  // the images finished alongside the video, so they don't speed up what is left
  assert.deepEqual({ done: run.done, left: run.left }, { done: 15, left: 45 });
  assert.equal(run.progress, (15 + 10) / 70);
  assert.deepEqual({ files: run.files, finished: run.finished }, { files: 3, finished: 2 });

  // a quality retry grows what is left; the bar holds where it was
  const retried = measureRun([{ ...items[0]!, progress: progress(0.2), scale: 1.5 }, ...items.slice(1)], costs);
  assert.deepEqual({ done: retried.done, left: retried.left }, { done: 18, left: 72 });
  assert.equal(retried.progress, run.progress);
});

test('a run of images is paced by all of them together', () => {
  const items = [item('a', 'image', { status: 'done' }), item('b', 'image', { status: 'waiting' })];
  const run = measureRun(items, { a: 12, b: 12 });
  assert.deepEqual({ done: run.done, left: run.left }, { done: 10, left: 10 });
});

test('an image reports each output as it starts, in step with the work', async (t) => {
  const dir = await tmpDir(t);
  const source = path.join(dir, 'photo.png');
  await photo(400, 300).png().toFile(source);
  const config = configWith({ images: { formats: ['original', 'webp', 'avif'] } });
  const events: Progress[] = [];
  await compressImage(jobFor(source, path.join(dir, 'out'), config), { ...config.images, skipLarger: true }, {
    onProgress: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.format), ['png', 'webp', 'avif']);
  assert.equal(events[0]?.overall, 0);
  for (let i = 1; i < events.length; i++) assert.ok(Number(events[i]?.overall) > Number(events[i - 1]?.overall));
  assert.ok(Number(events.at(-1)?.overall) < 1);
});

const skip = (await hasCommand('ffmpeg')) ? false : 'ffmpeg is not installed';

test('a video reports its progress across every pass and output', { skip }, async (t) => {
  const dir = await tmpDir(t);
  const source = path.join(dir, 'clip.mkv');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2', '-c:v', 'ffv1', source]);
  const config = configWith({ videos: { formats: ['mp4', 'webm'], quality: { check: false } } });
  const events: Progress[] = [];
  await compressVideo(jobFor(source, path.join(dir, 'out'), config, 'video'), config, { onProgress: (event) => events.push(event) });

  assert.ok(events.length > 0);
  assert.ok(events.some((event) => event.format === 'mp4') && events.some((event) => event.format === 'webm'));
  // the first VP9 pass has no position to report, but is still announced
  assert.ok(events.some((event) => event.format === 'webm' && event.stage.endsWith('pass 1/2')));
  for (const event of events) assert.ok(event.overall >= 0 && event.overall <= 1);
  // without retries, the share done only grows
  for (let i = 1; i < events.length; i++) assert.ok(Number(events[i]?.overall) >= Number(events[i - 1]?.overall) - 1e-9);
  assert.ok(Number(events.at(-1)?.overall) > 0.8);
});
