import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import type { DeepPartial } from '../engine/config.ts';
import type { Config, VideoSettings } from '../engine/types.ts';
import { run } from '../engine/utils/exec.ts';
import { compressVideo } from '../engine/videos/compress.ts';
import { hasFilter, probe } from '../engine/videos/ffmpeg.ts';
import { configWith, hasCommand, indexBy, jobFor, tmpDir } from './helpers.ts';

const skip = (await hasCommand('ffmpeg')) ? false : 'ffmpeg is not installed';
const vmaf = !skip && (await hasFilter('libvmaf'));

const lavfi = (args: string[], file: string) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
const PATTERN = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1'];
const TONE = ['-f', 'lavfi', '-i', 'sine=f=440:d=1'];

async function compress(
  t: TestContext,
  name: string,
  sourceArgs: string[],
  videos: DeepPartial<VideoSettings> = {},
  rest: DeepPartial<Config> = {},
) {
  const dir = await tmpDir(t);
  const source = path.join(dir, name);
  await lavfi(sourceArgs, source);
  const config = configWith({ videos, ...rest });
  const job = jobFor(source, path.join(dir, 'out'), config, 'video');
  const { results, warnings = [] } = await compressVideo(job, config);
  const byFormat = indexBy(results, (result) => result.format);
  return { source, results, warnings, byFormat };
}

const streamHash = async (file: string) =>
  (await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'])).stdout.toString();

test('a master becomes web-ready MP4 and WebM, each scored against it', { skip }, async (t) => {
  // lossless source with an odd frame size and stereo sound
  const { byFormat } = await compress(
    t,
    'master.mkv',
    ['-f', 'lavfi', '-i', 'testsrc2=s=321x181:r=24:d=1', ...TONE, '-c:v', 'ffv1', '-c:a', 'pcm_s16le'],
    { formats: ['mp4', 'webm'] },
    // on a one-second test pattern the WebM isn't reliably the smaller file
    { skipLarger: false },
  );

  const mp4 = await probe(byFormat.mp4.output);
  assert.equal(mp4.codec, 'h264');
  assert.equal(mp4.pixFmt, 'yuv420p');
  assert.equal(`${mp4.width}x${mp4.height}`, '320x180');
  assert.equal(mp4.audio?.codec, 'aac');
  // the index has to come before the media for playback to start while downloading
  const bytes = await readFile(byFormat.mp4.output);
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'));

  const webm = await probe(byFormat.webm.output);
  assert.equal(webm.codec, 'vp9');
  assert.equal(webm.audio?.codec, 'opus');

  if (vmaf) {
    for (const result of [byFormat.mp4, byFormat.webm]) assert.ok(Number(result?.vmaf) > 90, `VMAF ${result?.vmaf}`);
  }
});

test('an already compressed H.264 file keeps its streams bit for bit', { skip }, async (t) => {
  const { source, byFormat } = await compress(t, 'web.mp4', [...PATTERN, '-c:v', 'libx264', '-crf', '38', '-pix_fmt', 'yuv420p']);
  assert.match(byFormat.mp4.note ?? '', /streams copied untouched/);
  assert.equal(await streamHash(byFormat.mp4.output), await streamHash(source));
  assert.ok(Number(byFormat.mp4.bytes) <= (await stat(source)).size * 1.01);
});

test('videos are resized proportionally to even dimensions', { skip }, async (t) => {
  const { byFormat } = await compress(t, 'clip.mkv', [...PATTERN, '-c:v', 'ffv1'], {
    resize: { maxSize: 150 },
    quality: { check: false },
  });
  assert.equal(`${byFormat.mp4.width}x${byFormat.mp4.height}`, '150x84');
});

test('transparency survives in VP9 WebM and is reported as lost in MP4', { skip }, async (t) => {
  const alpha = "testsrc2=s=160x90:r=24:d=1,format=yuva444p10le,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(X,W/2),0,1023)'";
  const { byFormat, warnings } = await compress(
    t,
    'alpha.mov',
    ['-f', 'lavfi', '-i', alpha, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le'],
    { formats: ['mp4', 'webm'], quality: { check: false } },
  );
  assert.ok(warnings.some((warning) => /MP4: transparency dropped/.test(warning)));
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_tags=alpha_mode', '-of', 'csv=p=0', byFormat.webm.output,
  ]);
  assert.equal(stdout.toString().trim(), '1');
});

test('a poster frame is written at the size of the video', { skip }, async (t) => {
  const { byFormat } = await compress(t, 'clip.mkv', [...PATTERN, '-c:v', 'ffv1'], {
    poster: true,
    quality: { check: false },
  });
  assert.match(byFormat.poster.output, /clip-poster\.jpg$/);
  assert.equal(`${byFormat.poster.width}x${byFormat.poster.height}`, '320x180');
});

test('an encode that cannot hold quality is retried, then reported', { skip: skip || (vmaf ? false : 'no libvmaf') }, async (t) => {
  // a target no lossy encode can meet
  const { byFormat, warnings } = await compress(t, 'clip.mkv', [...PATTERN, '-c:v', 'ffv1'], {
    quality: { check: true, maxLoss: 0, attempts: 2, crfStep: 6 },
  });
  assert.match(byFormat.mp4.note ?? '', /crf lowered to 12/);
  assert.ok(warnings.some((warning) => /below a perfect copy/.test(warning)));
});
