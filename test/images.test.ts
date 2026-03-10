import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { TestContext } from 'node:test';
import { type DeepPartial } from '../engine/config.ts';
import { compressImage } from '../engine/images/compress.ts';
import { samePixels } from '../engine/images/pixels.ts';
import { type ImageSettings, type RequestedImageFormat, isSkipped } from '../engine/types.ts';
import { configWith, hasCommand, indexBy, jobFor, photo, pixels, png16, tmpDir } from './helpers.ts';

const ALL: RequestedImageFormat[] = ['original', 'webp', 'avif'];

// Writes a source file, from a buffer or by handing its path to `make`.
type Make = Buffer | ((file: string) => Promise<unknown>);

// Compresses one source and returns its results keyed by output file name.
async function compress(t: TestContext, name: string, make: Make, overrides: DeepPartial<ImageSettings> = {}, skipLarger = true) {
  const dir = await tmpDir(t);
  const source = path.join(dir, name);
  await (typeof make === 'function' ? make(source) : writeFile(source, make));
  const config = configWith({ images: { formats: ALL, ...overrides }, skipLarger });
  const job = jobFor(source, path.join(dir, 'out'), config);
  const { sourceBytes, results } = await compressImage(job, { ...config.images, skipLarger });
  const byName = indexBy(results, (result) => path.basename(result.output));
  return { source, sourceBytes, results, byName };
}

// Asserts the output shows exactly the picture the source does.
async function assertIdentical(source: string, output: string, options?: { deep?: boolean; animated?: boolean }) {
  const [before, after] = await Promise.all([pixels(source, options), pixels(output, options)]);
  assert.equal(`${after.width}x${after.height}`, `${before.width}x${before.height}`);
  assert.ok(samePixels(before.data, after.data, options?.deep), `${path.basename(output)} changed pixels`);
}

test('a photo with transparency stays pixel-exact in every format', async (t) => {
  const { source, sourceBytes, results } = await compress(t, 'photo.png', (file: string) => photo(320, 240, 4).png().toFile(file));
  const written = results.filter((result) => !isSkipped(result));
  assert.deepEqual(written.map((result) => result.format).sort(), ['avif', 'png', 'webp']);
  for (const result of written) {
    await assertIdentical(source, result.output);
    assert.ok(!isSkipped(result) && result.bytes <= sourceBytes, `${result.format} grew`);
  }
});

test('a flat graphic is stored as an indexed PNG, still pixel-exact', async (t) => {
  const { source, sourceBytes, byName } = await compress(t, 'flat.png', (file: string) =>
    sharp({ create: { width: 400, height: 200, channels: 3, background: '#0b3a4a' } })
      .composite([{ input: { create: { width: 100, height: 50, channels: 3, background: '#ff965d' } }, left: 20, top: 20 }])
      .png({ compressionLevel: 0 })
      .toFile(file),
  );
  await assertIdentical(source, byName['flat.png'].output);
  await assertIdentical(source, byName['flat.webp'].output);
  assert.ok(Number(byName['flat.png'].bytes) < sourceBytes / 10);
  assert.equal((await sharp(byName['flat.png'].output).metadata()).isPalette, true);
});

test('16-bit images keep their bit depth and are never squeezed into 8-bit formats', async (t) => {
  const { source, sourceBytes, byName } = await compress(t, 'deep.png', png16(48, 48));
  assert.equal((await sharp(source).metadata()).depth, 'ushort');
  assert.equal((await sharp(byName['deep.png'].output).metadata()).depth, 'ushort');
  await assertIdentical(source, byName['deep.png'].output, { deep: true });
  assert.ok(Number(byName['deep.png'].bytes) <= sourceBytes);
  assert.match(byName['deep.webp'].skipped ?? '', /pixel-exact/);
  assert.match(byName['deep.avif'].skipped ?? '', /pixel-exact/);
});

test('--lossy never applies to 16-bit images', async (t) => {
  const { source, byName } = await compress(t, 'deep.png', png16(48, 48), { lossy: true });
  await assertIdentical(source, byName['deep.png'].output, { deep: true });
});

test('greyscale stays single-channel', async (t) => {
  const { source, byName } = await compress(t, 'grey.png', (file: string) =>
    photo(200, 150).toColourspace('b-w').png().toFile(file),
  );
  assert.equal((await sharp(byName['grey.png'].output).metadata()).channels, 1);
  await assertIdentical(source, byName['grey.png'].output);
});

test('a wide-gamut profile is kept, with the samples untouched', async (t) => {
  const { source, results } = await compress(t, 'p3.png', (file: string) =>
    photo(200, 150).withIccProfile('p3').png().toFile(file),
  );
  for (const result of results.filter((entry) => !isSkipped(entry))) {
    await assertIdentical(source, result.output);
    assert.ok((await sharp(result.output).metadata()).icc, `${result.format} lost its colour profile`);
  }
});

test('a plain sRGB profile is dropped without touching the samples', async (t) => {
  const { source, byName } = await compress(t, 'tagged.png', (file: string) =>
    photo(200, 150).withIccProfile('srgb').png().toFile(file),
  );
  assert.ok((await sharp(source).metadata()).icc);
  assert.equal((await sharp(byName['tagged.png'].output).metadata()).icc, undefined);
  await assertIdentical(source, byName['tagged.png'].output);
});

test('an opaque alpha channel is dropped', async (t) => {
  const { source, byName } = await compress(t, 'opaque.png', (file: string) => photo(200, 150).ensureAlpha().png().toFile(file));
  assert.equal((await sharp(byName['opaque.png'].output).metadata()).channels, 3);
  await assertIdentical(source, byName['opaque.png'].output);
});

test('a JPEG is repacked without re-encoding, and not converted to something bigger', async (t) => {
  const { source, sourceBytes, byName } = await compress(t, 'photo.jpg', (file: string) =>
    photo(400, 300).jpeg({ quality: 90 }).toFile(file),
  );
  const jpeg = byName['photo.jpg'];
  await assertIdentical(source, jpeg.output);
  assert.ok(Number(jpeg.bytes) <= sourceBytes);
  if (await hasCommand('jpegtran', ['-version'])) assert.ok(Number(jpeg.bytes) < sourceBytes, 'jpegtran found nothing to save');
  assert.match(byName['photo.webp'].skipped ?? '', /not smaller/);
  assert.equal(byName['photo.webp'].tip, 'lossy');
});

test('a rotated JPEG still displays the right way up', async (t) => {
  const { source, byName } = await compress(t, 'rotated.jpg', (file: string) =>
    photo(300, 200).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toFile(file),
  );
  const upright = (file: string) => sharp(file).autoOrient().raw().toBuffer({ resolveWithObject: true });
  const [before, after] = await Promise.all([upright(source), upright(byName['rotated.jpg'].output)]);
  assert.equal(`${after.info.width}x${after.info.height}`, '200x300');
  assert.ok(before.data.equals(after.data));
});

test('a source that is already optimal is passed through byte for byte', async (t) => {
  const { source, sourceBytes, byName } = await compress(t, 'tiny.webp', (file: string) =>
    photo(200, 150).webp({ quality: 30 }).toFile(file),
  );
  assert.equal(byName['tiny.webp'].note, 'already optimal');
  assert.equal(byName['tiny.webp'].bytes, sourceBytes);
  assert.ok((await readFile(source)).equals(await readFile(byName['tiny.webp'].output)));
});

test('an animated GIF keeps every frame and its timing as WebP', async (t) => {
  const frame = (shade: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 40, b: 200 - shade } } }).png().toBuffer();
  const frames = await Promise.all([10, 90, 170].map(frame));
  const { source, byName } = await compress(t, 'anim.gif', (file: string) =>
    sharp(frames, { join: { animated: true } }).gif({ delay: [80, 120, 200] }).toFile(file),
  );
  const webp = await sharp(byName['anim.webp'].output, { animated: true }).metadata();
  assert.equal(webp.pages, 3);
  assert.deepEqual(webp.delay, [80, 120, 200]);
  await assertIdentical(source, byName['anim.webp'].output, { animated: true });
  assert.match(byName['anim.avif'].skipped ?? '', /animated/);
});

test('resizing is proportional and never enlarges', async (t) => {
  const make = (file: string) => photo(400, 300).png().toFile(file);
  const half = await compress(t, 'a.png', make, { formats: ['original'], resize: { scale: 50 } });
  assert.equal(`${half.byName['a.png'].width}x${half.byName['a.png'].height}`, '200x150');
  const tall = await compress(t, 'a.png', make, { formats: ['original'], resize: { height: 100, width: 1000 } });
  assert.equal(`${tall.byName['a.png'].width}x${tall.byName['a.png'].height}`, '133x100');
  const huge = await compress(t, 'a.png', make, { formats: ['original'], resize: { maxSize: 5000 } });
  assert.equal(`${huge.byName['a.png'].width}x${huge.byName['a.png'].height}`, '400x300');
  await assertIdentical(huge.source, huge.byName['a.png'].output);
});

test('a resized image is stored exactly as resized', async (t) => {
  const { source, byName } = await compress(t, 'a.png', (file: string) => photo(400, 300, 4).png().toFile(file), {
    formats: ['original', 'webp'],
    resize: { width: 200 },
  });
  const expected = await sharp(source, { ignoreIcc: true }).resize({ width: 200, height: 150, fit: 'fill' }).ensureAlpha().raw().toBuffer();
  for (const name of ['a.png', 'a.webp']) {
    const actual = await pixels(byName[name].output);
    assert.ok(samePixels(expected, actual.data), `${name} is not the resized picture`);
  }
});

test('responsive widths skip sizes the source cannot fill', async (t) => {
  const { results } = await compress(t, 'a.png', (file: string) => photo(400, 300).png().toFile(file), {
    formats: ['original'],
    widths: [200, 400, 800],
  });
  assert.deepEqual(results.map((result) => `${path.basename(result.output)} ${isSkipped(result) ? '' : result.width}`), ['a.png 400', 'a-200w.png 200']);
});

test('--lossy trades exact pixels for much smaller files that still look the same', async (t) => {
  // camera-like grain: heavy synthetic noise is a worst case no real photo reaches
  const make = (file: string) => photo(400, 300, 4, 6).png().toFile(file);
  const exact = await compress(t, 'a.png', make);
  const lossy = await compress(t, 'a.png', make, { lossy: true });
  for (const name of ['a.png', 'a.webp', 'a.avif']) {
    assert.ok(Number(lossy.byName[name]?.bytes) < Number(exact.byName[name]?.bytes) * 0.8, `${name} barely shrank`);
  }
  const flat = (file: string) => sharp(file).flatten({ background: '#fff' }).raw().toBuffer();
  const [before, after] = await Promise.all([flat(lossy.source), flat(lossy.byName['a.webp'].output)]);
  let squared = 0;
  for (let i = 0; i < before.length; i++) squared += (Number(before[i]) - Number(after[i])) ** 2;
  const psnr = 10 * Math.log10(65025 / (squared / before.length));
  assert.ok(psnr > 38, `PSNR ${psnr.toFixed(1)} dB`);
});

test('an SVG is optimised without changing how it renders or its ids', async (t) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator 27.0.0 -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 120" xml:space="preserve">
  <g id="group_1"><title>icon</title>
    <circle id="dot" class="st0" fill="#FF965D" cx="60.0000" cy="60.0000" r="50.0000"/>
    <path d="M 30.000 60.000 L 90.000 60.000 L 60.000 90.000 Z" fill="#000000"/>
  </g>
</svg>`;
  const { source, sourceBytes, results } = await compress(t, 'icon.svg', Buffer.from(svg));
  const [result] = results;
  assert.ok(result && !isSkipped(result) && result.bytes < sourceBytes);
  const out = await readFile(result.output, 'utf8');
  assert.match(out, /viewBox="0 0 120 120"/);
  assert.match(out, /id="group_1"/);
  assert.match(out, /id="dot"/);
  const render = (file: string) => sharp(file, { density: 144 }).ensureAlpha().raw().toBuffer();
  assert.ok((await render(source)).equals(await render(result.output)));
});

test('skipLarger: false writes conversions even when they lose', async (t) => {
  const { byName } = await compress(t, 'photo.jpg', (file: string) => photo(300, 200).jpeg({ quality: 80 }).toFile(file), {}, false);
  assert.ok(Number(byName['photo.webp'].bytes) > (await stat(byName['photo.jpg'].output)).size);
});
