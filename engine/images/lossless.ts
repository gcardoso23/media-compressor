import sharp, { type Metadata, type Sharp } from 'sharp';
import type { ImageFormat, ImageOptions } from '../types.ts';
import type { Size } from '../utils/size.ts';
import { hasRedundantProfile } from './icc.ts';
import { type CopyMarkers, optimizeJpeg } from './jpegtran.ts';
import { type Pixels, countColours, decode, isDeep, isOpaque, isVerifiable, samePixels } from './pixels.ts';

type Encode = (image: Sharp) => Sharp;

interface Reference extends Pixels {
  opaque: boolean;
  colours: number;
}

// What an encoder hands back. `data` without `note` is a verified exact copy.
export interface Encoded {
  data?: Buffer;
  width?: number;
  height?: number;
  exact?: boolean;
  note?: string;
  skipped?: string;
  // the conversion could not have come out smaller than its budget
  tooLarge?: boolean;
}

function candidates(format: ImageFormat, { colours }: Reference): Encode[] {
  switch (format) {
    case 'png':
      return [
        // No `effort` on these two: sharp turns palette quantisation on whenever it is set.
        // Adaptive filtering wins on photos and loses on flat graphics.
        (image) => image.png({ compressionLevel: 9 }),
        (image) => image.png({ compressionLevel: 9, adaptiveFiltering: true }),
        // an indexed PNG holds up to 256 colours exactly, at a fraction of the size
        ...(colours <= 256
          ? [(image: Sharp) => image.png({ palette: true, quality: 100, dither: 0, effort: 10, compressionLevel: 9 })]
          : []),
      ];
    case 'webp':
      return [(image) => image.webp({ lossless: true, effort: 6 })];
    case 'avif':
      return [(image) => image.avif({ lossless: true, effort: 6 })];
    case 'gif':
      return [(image) => image.gif({ effort: 10, dither: 0, interFrameMaxError: 0, interPaletteMaxError: 0 })];
    default:
      return [];
  }
}

// Minimum-effort stand-ins for the lossless encoders above.
const QUICK: Partial<Record<ImageFormat, Encode>> = {
  webp: (image) => image.webp({ lossless: true, effort: 0 }),
  avif: (image) => image.avif({ lossless: true, effort: 0 }),
};
// Formats whose files are usually lossy already.
const LOSSY_SOURCES = new Set(['jpeg', 'webp', 'avif']);

const sameList = (a: number[] = [], b: number[] = []) => a.length === b.length && a.every((value, index) => value === b[index]);

export interface ExactEncoderOptions {
  input: Buffer;
  meta: Metadata;
  sourceFormat: string;
  animated: boolean;
  size: Size | null;
  images: ImageOptions;
}

// `budget` is the size a conversion has to beat to be worth writing at all.
export type ExactEncoder = (format: ImageFormat, untouched: boolean, budget?: number) => Promise<Encoded>;

// Builds the pixel-exact encoder for one source at one size. Every result it
// returns without a note has been decoded again and compared with the source,
// sample for sample.
export function createExactEncoder({ input, meta, sourceFormat, animated, size, images }: ExactEncoderOptions): ExactEncoder {
  const deep = isDeep(meta);
  const dropProfile = !images.keepMetadata && hasRedundantProfile(meta.icc);
  let reference: Reference | undefined;

  const prepare = (image: Sharp) => {
    // bake the EXIF rotation in, since the EXIF itself is stripped
    if (!animated) image = image.autoOrient();
    if (size) image = image.resize({ ...size, fit: 'fill' });
    return image;
  };

  const loadReference = async (): Promise<Reference> => {
    const pixels = await decode(input, { deep, animated, prepare });
    return {
      ...pixels,
      opaque: isOpaque(pixels.data, deep),
      colours: deep ? Infinity : countColours(pixels.data),
    };
  };

  // The samples are never colour-converted. The profile that gives them their
  // meaning is carried over, unless it only restates the sRGB default.
  const pipeline = (ref?: Reference) => {
    let image = prepare(sharp(input, { animated, ignoreIcc: dropProfile }));
    if (images.keepMetadata) image = image.keepMetadata();
    else if (!dropProfile) image = image.keepIccProfile();
    image = image.toColourspace(meta.space);
    if (meta.hasAlpha && ref?.opaque) image = image.removeAlpha();
    return image;
  };

  const matches = async (data: Buffer, ref: Reference) => {
    const pixels = await decode(data, { deep, animated });
    if (pixels.width !== ref.width || pixels.height !== ref.height) return false;
    if (!samePixels(pixels.data, ref.data, deep)) return false;
    if (!animated) return true;
    const encoded = await sharp(data, { animated: true }).metadata();
    return encoded.pages === meta.pages && encoded.loop === meta.loop && sameList(encoded.delay, meta.delay);
  };

  // The outputs that can't be pixel-exact: these formats have no way to store
  // new pixels losslessly, or none that wouldn't outweigh the source.
  const approximate = async (format: ImageFormat): Promise<Encoded> => {
    const quality = images.reencodeQuality;
    let image = pipeline();
    let note: string;
    if (format === 'jpeg') {
      if (meta.hasAlpha) image = image.flatten({ background: images.background });
      image = image.jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true });
      note = `JPEG is always lossy, written at q${quality}`;
    } else if (format === 'gif') {
      image = image.gif({ effort: 10 });
      note = 'GIF holds 256 colours, the resized frames were matched to them';
    } else {
      image = format === 'webp' ? image.webp({ quality, effort: 6, smartSubsample: true }) : image.avif({ quality });
      note = `lossless would outweigh the source, written at q${quality}`;
    }
    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.pageHeight ?? info.height, note };
  };

  // A pixel-exact copy of an already lossy image is typically several times
  // its size. A minimum-effort encode shows that in a fraction of the time, so
  // the full one only runs when it stands a chance: in testing, full effort was
  // at most 2.6x smaller than minimum effort, and this asks for 4x.
  const cannotBeat = async (format: ImageFormat, budget: number | undefined, ref: Reference) => {
    const quick = QUICK[format];
    if (!budget || !quick || !LOSSY_SOURCES.has(sourceFormat)) return false;
    const data = await quick(pipeline(ref)).toBuffer();
    return data.length > budget * 4;
  };

  const repackJpeg = async (): Promise<Encoded> => {
    // an EXIF rotation can only be kept by keeping the EXIF
    const rotated = (meta.orientation ?? 1) > 1;
    let copy: CopyMarkers = 'none';
    if (images.keepMetadata || rotated) copy = 'all';
    else if (meta.icc && !dropProfile) copy = 'icc';

    const data = await optimizeJpeg(input, { copy });
    if (!data) return { note: 'install jpegtran to optimise JPEGs losslessly' };
    const [before, after] = await Promise.all(
      [input, data].map((buffer) => sharp(buffer, { ignoreIcc: true }).raw().toBuffer()),
    );
    return before && after && before.equals(after) ? { data, exact: true } : {};
  };

  return async function encodeExact(format, untouched, budget) {
    if (format === 'jpeg') return untouched ? repackJpeg() : approximate('jpeg');
    if (!isVerifiable(meta)) return { skipped: `${meta.space} source, converting it would change its colours` };

    reference ??= await loadReference();
    const ref = reference;
    if (await cannotBeat(format, budget, ref)) return { tooLarge: true };
    const encoded = await Promise.all(candidates(format, ref).map((make) => make(pipeline(ref)).toBuffer()));
    let exact: Buffer | undefined;
    for (const data of encoded.sort((a, b) => a.length - b.length)) {
      if (await matches(data, ref)) {
        exact = data;
        break;
      }
    }

    if (!untouched) {
      // resampling creates colours a GIF palette can't all hold
      if (!exact && format === 'gif') return approximate('gif');
      // a lossy WebP / AVIF stored losslessly at a smaller size still comes out bigger
      const lossyFormat = format === 'webp' || format === 'avif';
      if (size && lossyFormat && format === sourceFormat && (exact?.length ?? Infinity) >= input.length) {
        return approximate(format);
      }
    }
    if (!exact) return { skipped: `${format} can't hold this image pixel-exact` };
    const height = animated ? ref.height / (meta.pages ?? 1) : ref.height;
    return { data: exact, width: ref.width, height, exact: true };
  };
}
