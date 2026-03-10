import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { ImageFormat, ImageOptions, Job, Outcome, Result } from '../types.ts';
import { type Size, fitSize } from '../utils/size.ts';
import { hasRedundantProfile } from './icc.ts';
import { type Encoded, type ExactEncoder, createExactEncoder } from './lossless.ts';
import { encodeLossy } from './lossy.ts';
import { isDeep } from './pixels.ts';
import { compressSvg } from './svg.ts';

// Formats sharp can write with every frame intact.
const ANIMATED_FORMATS = new Set(['gif', 'webp']);
// Formats whose files are usually lossy already.
const LOSSY_SOURCES = new Set(['jpeg', 'webp', 'avif']);

async function write(file: string, data: Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

// Encodes every planned output of one source image, with one result per file
// written or deliberately skipped.
export async function compressImage(job: Job, images: ImageOptions): Promise<Outcome> {
  const input = await readFile(job.source);

  const [first] = job.outputs;
  if (first?.format === 'svg') {
    const { data, note } = await compressSvg(input, images);
    await write(first.path, data);
    const result: Result = { output: first.path, format: 'svg', native: true, bytes: data.length, exact: !images.lossy, note };
    return { sourceBytes: input.length, results: [result] };
  }

  const meta = await sharp(input, { animated: true }).metadata();
  const animated = (meta.pages ?? 1) > 1;
  const source = {
    format: meta.format === 'heif' ? 'avif' : String(meta.format),
    width: animated ? meta.width : (meta.autoOrient?.width ?? meta.width),
    height: animated ? (meta.pageHeight ?? meta.height) : (meta.autoOrient?.height ?? meta.height),
  };
  // 16-bit sources always take the exact path: no lossy encoder here keeps their precision
  const exactOnly = !images.lossy || isDeep(meta);
  const fullSize = fitSize(source, images.resize);
  const fullWidth = (fullSize ?? source).width;

  // One entry per output size. `baseline` is the smallest faithful file at
  // that size so far, which the other formats have to beat to be worth writing.
  const variants = new Map<string, { encodeExact: ExactEncoder; baseline?: number }>();
  const variantFor = (size: Size | null) => {
    const key = size ? `${size.width}x${size.height}` : 'source';
    let variant = variants.get(key);
    if (!variant) {
      variant = {
        encodeExact: createExactEncoder({ input, meta, sourceFormat: source.format, animated, size, images }),
        baseline: size ? undefined : input.length,
      };
      variants.set(key, variant);
    }
    return variant;
  };

  const lossyPipeline = (size: Size | null) => {
    const dropProfile = !images.keepMetadata && hasRedundantProfile(meta.icc);
    let image = sharp(input, { animated, ignoreIcc: dropProfile });
    if (!animated) image = image.autoOrient();
    if (size) image = image.resize({ ...size, fit: 'fill' });
    if (images.keepMetadata) image = image.keepMetadata();
    else if (!dropProfile) image = image.keepIccProfile();
    return image.toColourspace(meta.space);
  };

  const results: Result[] = [];
  // the source's own format first, so it sets the baseline for the conversions
  const outputs = [...job.outputs].sort((a, b) => Number(Boolean(b.native)) - Number(Boolean(a.native)));

  for (const out of outputs) {
    const format = out.format as ImageFormat;
    let size = fullSize;
    if (out.width) {
      // the full-size file already covers widths the source can't fill
      if (out.width >= fullWidth) continue;
      size = fitSize(source, { width: out.width });
    }
    const skip = (reason: string, tip?: 'lossy') => results.push({ output: out.path, format, skipped: reason, tip });

    if (animated && !ANIMATED_FORMATS.has(format)) {
      skip(`animated source, ${format} would keep one frame`);
      continue;
    }

    const variant = variantFor(size);
    // same format, same pixels: the source file itself is a valid output
    const untouched = !size && format === source.format;

    let encoded: Encoded | undefined;
    if (!exactOnly) {
      const lossy = await encodeLossy(lossyPipeline(size), format, {
        images,
        hasAlpha: Boolean(meta.hasAlpha),
        sourceFormat: source.format,
      });
      encoded = {
        data: lossy.data,
        width: lossy.info.width,
        height: lossy.info.pageHeight ?? lossy.info.height,
        note: lossy.note,
      };
    }
    // what a conversion has to beat: one that isn't smaller is not worth shipping
    const budget = !out.native && !untouched && images.skipLarger ? variant.baseline : undefined;
    // also the fallback for sources that are already smaller than a lossy re-encode
    if (!encoded || (untouched && (encoded.data?.length ?? Infinity) >= input.length)) {
      encoded = await variant.encodeExact(format, untouched, budget);
    }

    let data: Buffer;
    let result: Encoded;
    if (untouched && (!encoded.data || encoded.data.length >= input.length)) {
      data = input;
      result = { ...source, exact: true, note: encoded.note ?? 'already optimal' };
    } else if (encoded.skipped) {
      skip(encoded.skipped);
      continue;
    } else if (!encoded.data || encoded.tooLarge || encoded.data.length >= (budget ?? Infinity)) {
      // nearly always a source that is lossy already, which visually lossless mode can still convert
      const tip = exactOnly && LOSSY_SOURCES.has(source.format) ? 'lossy' : undefined;
      skip(`${exactOnly ? 'lossless ' : ''}${format} is not smaller than the ${source.format}`, tip);
      continue;
    } else {
      data = encoded.data;
      // a repacked JPEG reports no size of its own: it is the source's
      result = { ...source, ...encoded };
    }

    await write(out.path, data);
    if (out.native || untouched) variant.baseline = Math.min(variant.baseline ?? Infinity, data.length);
    results.push({
      output: out.path,
      format,
      native: out.native,
      bytes: data.length,
      width: result.width,
      height: result.height,
      exact: Boolean(result.exact),
      note: result.note,
    });
  }

  return { sourceBytes: input.length, results };
}
