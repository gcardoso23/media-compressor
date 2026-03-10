import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import zlib from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import defaults from '../media.config.ts';
import { type DeepPartial, merge } from '../engine/config.ts';
import type { Pixels } from '../engine/images/pixels.ts';
import { planJobs } from '../engine/plan.ts';
import type { Config, Job, MediaKind, Result, Skipped, Written } from '../engine/types.ts';
import { run } from '../engine/utils/exec.ts';

export async function tmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-compressor-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// The project defaults with `overrides` deep-merged in.
export function configWith(overrides: DeepPartial<Config> = {}): Config {
  return merge(structuredClone(defaults), overrides);
}

// The single job planned for `file`, written into `outDir`.
export function jobFor(file: string, outDir: string, config: Config, kind: MediaKind = 'image'): Job {
  const [job] = planJobs([{ file, rel: path.basename(file) }], { outDir, config, kinds: [kind] });
  if (!job) throw new Error(`nothing planned for ${file}`);
  return job;
}

// A result with every field optional, for tests that know which one they expect.
export type AnyResult = Omit<Partial<Written> & Partial<Skipped>, 'output' | 'format'> & Pick<Result, 'output' | 'format'>;

export const indexBy = (results: Result[], key: (result: Result) => string): Record<string, AnyResult> =>
  Object.fromEntries(results.map((result) => [key(result), result as AnyResult]));

// Deterministic photo-like pixels: smooth gradients plus `grain` levels of
// noise, which is what makes real photos hard to compress.
export function photo(width: number, height: number, channels: 3 | 4 = 3, grain = 24): Sharp {
  const data = Buffer.alloc(width * height * channels);
  let seed = 42;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 24) % grain;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      data[i] = Math.min(255, (x * 255) / width + noise());
      data[i + 1] = Math.min(255, (y * 255) / height + noise());
      data[i + 2] = Math.min(255, ((x + y) * 127) / (width + height) + noise());
      // transparent left third, so hidden pixels are exercised too
      if (channels === 4) data[i + 3] = x < width / 3 ? 0 : 255;
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// A 16-bit RGB PNG whose samples genuinely need all 16 bits, written by hand
// so the fixture doesn't depend on the encoder under test.
export function png16(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([16, 2, 0, 0, 0], 8);

  const stride = 1 + width * 6;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) {
      rows.writeUInt16BE((x * 523 + y * 7919 + 1) % 65536, y * stride + 1 + x * 2);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// RGBA samples exactly as stored, with no colour management applied.
export async function pixels(file: string | Buffer, { deep = false, animated = false } = {}): Promise<Pixels> {
  const { data, info } = await sharp(file, { ignoreIcc: true, animated })
    .toColourspace(deep ? 'rgb16' : 'srgb')
    .ensureAlpha()
    .raw({ depth: deep ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function hasCommand(bin: string, args = ['-version']): Promise<boolean> {
  try {
    await run(bin, args);
    return true;
  } catch {
    return false;
  }
}
