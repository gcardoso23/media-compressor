import sharp, { type Metadata, type Sharp } from 'sharp';

// Pixel layouts that can be decoded and compared sample for sample.
const EXACT_SPACES = new Set(['srgb', 'b-w', 'rgb16', 'grey16']);

export const isVerifiable = (meta: Metadata) =>
  EXACT_SPACES.has(String(meta.space)) && (meta.depth === 'uchar' || meta.depth === 'ushort');
export const isDeep = (meta: Metadata) => meta.depth === 'ushort';

export interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}

// Decodes to RGBA at the source's own bit depth. `ignoreIcc` matters: without
// it sharp converts the samples through the embedded colour profile.
export async function decode(
  input: Buffer,
  { deep = false, animated = false, prepare }: { deep?: boolean; animated?: boolean; prepare?: (image: Sharp) => Sharp } = {},
): Promise<Pixels> {
  let image = sharp(input, { animated, ignoreIcc: true });
  if (prepare) image = prepare(image);
  const { data, info } = await image
    .toColourspace(deep ? 'rgb16' : 'srgb')
    .ensureAlpha()
    .raw({ depth: deep ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// True when two RGBA buffers show the same picture. The colour stored under
// fully transparent pixels is ignored: it is invisible and encoders rewrite it.
export function samePixels(a: Buffer, b: Buffer, deep = false): boolean {
  if (a.length !== b.length) return false;
  if (a.equals(b)) return true;

  const step = deep ? 8 : 4;
  const hidden = (buffer: Buffer, i: number) => buffer[i + step - 1] === 0 && (!deep || buffer[i + step - 2] === 0);
  for (let i = 0; i < a.length; i += step) {
    if (hidden(a, i) && hidden(b, i)) continue;
    for (let j = i; j < i + step; j++) {
      if (a[j] !== b[j]) return false;
    }
  }
  return true;
}

export function isOpaque(data: Buffer, deep = false): boolean {
  const step = deep ? 8 : 4;
  for (let i = step - 1; i < data.length; i += step) {
    if (data[i] !== 255 || (deep && data[i - 1] !== 255)) return false;
  }
  return true;
}

// Number of distinct colours in an 8-bit RGBA buffer, giving up past `limit`.
export function countColours(data: Buffer, limit = 256): number {
  const aligned = data.byteOffset % 4 === 0 ? data : Buffer.from(data);
  const pixels = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);
  const seen = new Set<number>();
  for (const pixel of pixels) {
    seen.add(pixel);
    if (seen.size > limit) break;
  }
  return seen.size;
}
