import path from 'node:path';
import { kindOf } from './media.ts';
import type { Config, ImageFormat, Job, MediaKind, OutputFormat, PlannedOutput, RequestedImageFormat, VideoFormat } from './types.ts';

export { kindOf };

export const IMAGE_FORMATS: readonly RequestedImageFormat[] = ['original', 'jpeg', 'png', 'webp', 'avif'];
export const VIDEO_FORMATS: readonly VideoFormat[] = ['mp4', 'webm'];

// What 'original' means per source type. TIFF isn't a web format: it becomes
// PNG, or JPEG when lossy output is allowed.
const NATIVE_FORMAT: Record<string, ImageFormat> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.avif': 'avif',
  '.gif': 'gif',
};
const FORMAT_EXT: Record<Exclude<OutputFormat, 'svg'>, string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
  mp4: '.mp4',
  webm: '.webm',
};

export interface Source {
  file: string;
  // the path the file keeps inside the output directory
  rel: string;
}

// Turns source files into jobs with fully resolved output paths, so collisions
// and source overwrites are caught before anything is encoded.
export function planJobs(
  sources: Source[],
  { outDir, config, kinds }: { outDir: string; config: Config; kinds: MediaKind[] },
): Job[] {
  const claimed = new Set<string>();
  const jobs: Job[] = [];

  for (const { file, rel } of sources) {
    const kind = kindOf(file);
    if (!kind || !kinds.includes(kind)) continue;

    const srcExt = path.extname(file);
    const ext = srcExt.toLowerCase();
    const dir = path.join(outDir, path.dirname(rel));
    const name = path.basename(rel, srcExt);

    const claim = (suffix: string, outExt: string) => {
      let out = path.join(dir, `${name}${suffix}${outExt}`);
      // hero.jpg and hero.png would both become hero.webp: keep the source ext to tell them apart
      if (claimed.has(out)) out = path.join(dir, `${name}${srcExt}${suffix}${outExt}`);
      if (out === file) {
        throw new Error(`Output would overwrite its source: ${file}\nUse a different --out directory.`);
      }
      claimed.add(out);
      return out;
    };

    if (kind === 'video') {
      const { formats, poster, posterFormat } = config.videos;
      jobs.push({
        kind,
        source: file,
        rel,
        outputs: formats.map((format) => ({ format, path: claim('', FORMAT_EXT[format]) })),
        poster: poster ? claim('-poster', posterFormat === 'jpeg' ? '.jpg' : `.${posterFormat}`) : null,
      });
      continue;
    }

    // SVGs are only ever optimised in place: rasterising a vector is never the smaller option.
    if (ext === '.svg') {
      jobs.push({ kind, source: file, rel, outputs: [{ format: 'svg', path: claim('', srcExt) }] });
      continue;
    }

    const outputs: PlannedOutput[] = [];
    const seen = new Set<ImageFormat>();
    const tiff = ext.startsWith('.tif');
    for (const requested of config.images.formats) {
      const native = requested === 'original';
      const format: ImageFormat = native ? (NATIVE_FORMAT[ext] ?? (config.images.lossy ? 'jpeg' : 'png')) : requested;
      if (seen.has(format)) continue;
      seen.add(format);
      // 'original' keeps the exact file name so existing references keep working
      const outExt = native && !tiff ? srcExt : FORMAT_EXT[format];
      outputs.push({ format, native, path: claim('', outExt) });
      for (const width of config.images.widths) {
        outputs.push({ format, native, width, path: claim(`-${width}w`, outExt) });
      }
    }
    jobs.push({ kind, source: file, rel, outputs });
  }

  return jobs;
}
