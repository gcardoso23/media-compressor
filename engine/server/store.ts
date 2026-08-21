import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import defaults from '../../media.config.ts';
import type { MediaInfo } from '../estimate.ts';
import { compressImage } from '../images/compress.ts';
import { kindOf } from '../media.ts';
import { OPTIONS, applyFlags } from '../options.ts';
import { planJobs } from '../plan.ts';
import { type Config, type MediaKind, type Progress, isSkipped } from '../types.ts';
import { limiter } from '../utils/pool.ts';
import { compressVideo } from '../videos/compress.ts';
import { probe } from '../videos/ffmpeg.ts';
import type { CompressEvent, Flags, PublicResult, Uploaded } from './protocol.ts';
import type { ZipEntry } from './zip.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Entry {
  id: string;
  name: string;
  kind: MediaKind;
  dir: string;
  source: string;
  // files written by the latest run
  outputs: string[];
  runs: number;
  // runs for the same file never overlap
  queue: Promise<void>;
}

// What the interface needs to estimate how long a file will take.
async function inspect(file: string, kind: MediaKind): Promise<MediaInfo | null> {
  try {
    if (kind === 'video') {
      const info = await probe(file);
      return { width: info.width, height: info.height, frames: Math.max(1, Math.round(info.duration * info.fps)), duration: info.duration };
    }
    const meta = await sharp(file, { animated: true }).metadata();
    const frames = meta.pages ?? 1;
    if (frames > 1) return { width: meta.width, height: meta.pageHeight ?? meta.height, frames };
    return { width: meta.autoOrient?.width ?? meta.width, height: meta.autoOrient?.height ?? meta.height, frames: 1 };
  } catch {
    return null;
  }
}

// Flags that only make sense for the folder scripts.
const FOLDER_ONLY = new Set(['out', 'config', 'force', 'dry-run', 'help']);

// Keeps only the flags the interface may set, as the types applyFlags expects.
function pickFlags(body: unknown): Flags {
  const flags: Flags = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!(key in OPTIONS) || FOLDER_ONLY.has(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'string') flags[key] = value;
    else if (typeof value === 'number') flags[key] = String(value);
  }
  return flags;
}

interface State {
  root: string;
  files: Map<string, Entry>;
  slots: Record<MediaKind, ReturnType<typeof limiter>>;
}

// The uploads live on globalThis, so they survive Next.js re-evaluating
// modules in development. Only data is kept there: the functions below always
// come from the current code.
const KEY = Symbol.for('media-compressor.uploads');
const holder = globalThis as typeof globalThis & { [KEY]?: State };

function state(): State {
  if (!holder[KEY]) {
    // kept in a temporary folder that is removed when the process exits
    const root = mkdtempSync(path.join(os.tmpdir(), 'media-compressor-'));
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));
    // sharp is multi-threaded per image and ffmpeg per video, so videos run one at a time
    holder[KEY] = { root, files: new Map(), slots: { image: limiter(3), video: limiter(1) } };
  }
  return holder[KEY];
}

function entryFor(id: string): Entry {
  const entry = state().files.get(id);
  if (!entry) throw new HttpError(404, 'That file is no longer on the server. Add it again.');
  return entry;
}

// What the interface works with: uploaded sources and their latest outputs.
function createStore() {
  return {
    async upload(rawName: string, body: Readable): Promise<Uploaded> {
      const name = path.basename(rawName).replace(/[\\/:\0]/g, '_');
      const kind = name ? kindOf(name) : null;
      if (!kind) throw new HttpError(415, `${name || 'This file'} is not an image or video this tool can read`);

      const id = randomUUID().slice(0, 8);
      const dir = path.join(state().root, id);
      const source = path.join(dir, 'source', name);
      await mkdir(path.dirname(source), { recursive: true });
      await pipeline(body, createWriteStream(source));
      state().files.set(id, { id, name, kind, dir, source, outputs: [], runs: 0, queue: Promise.resolve() });
      return { id, name, kind, bytes: (await stat(source)).size, media: await inspect(source, kind) };
    },

    // Validates the settings up front, so a bad request fails before streaming starts.
    prepare(id: string, body: unknown): { entry: Entry; config: Config } {
      const entry = entryFor(id);
      try {
        return { entry, config: applyFlags(structuredClone(defaults), pickFlags(body)) };
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    },

    // Compresses one file, reporting progress and the outcome through `send`.
    async compress(entry: Entry, config: Config, send: (event: CompressEvent) => void, signal: AbortSignal): Promise<void> {
      send({ type: 'queued' });
      const work = () =>
        state().slots[entry.kind](async () => {
          if (signal.aborted) return;
          send({ type: 'started' });

          const report = (progress: Progress) => send({ type: 'progress', ...progress });
          // every run gets its own folder, so a download never reads a half-written file
          const run = ++entry.runs;
          const outDir = path.join(entry.dir, `out-${run}`);
          const [job] = planJobs([{ file: entry.source, rel: entry.name }], { outDir, config, kinds: [entry.kind] });
          if (!job) throw new Error(`${entry.name} has nothing to compress`);
          const { sourceBytes, results, warnings = [] } =
            entry.kind === 'image'
              ? await compressImage(job, { ...config.images, skipLarger: config.skipLarger }, { onProgress: report })
              : await compressVideo(job, config, { signal, onProgress: report });

          entry.outputs = results.flatMap((result) => (isSkipped(result) ? [] : [result.output]));
          if (run > 1) await rm(path.join(entry.dir, `out-${run - 1}`), { recursive: true, force: true });
          send({
            type: 'done',
            sourceBytes,
            warnings,
            results: results.map((result): PublicResult => {
              const name = path.basename(result.output);
              if (isSkipped(result)) {
                const { output, ...rest } = result;
                return { ...rest, name };
              }
              const { output, ...rest } = result;
              return { ...rest, name, url: `/api/files/${entry.id}/runs/${run}/${encodeURIComponent(name)}` };
            }),
          });
        });

      entry.queue = entry.queue.then(work).catch((error: unknown) => {
        if (!signal.aborted) send({ type: 'error', message: (error as Error).message });
      });
      await entry.queue;
    },

    async remove(id: string): Promise<void> {
      const entry = entryFor(id);
      state().files.delete(id);
      await rm(entry.dir, { recursive: true, force: true });
    },

    outputPath(id: string, run: string, name: string): string {
      return path.join(entryFor(id).dir, `out-${Number(run)}`, path.basename(name));
    },

    // Every latest output of these files, named uniquely for one ZIP.
    zipEntries(ids: string[]): ZipEntry[] {
      const used = new Set<string>();
      const entries: ZipEntry[] = [];
      for (const id of ids) {
        for (const output of state().files.get(id)?.outputs ?? []) {
          // two sources can produce the same name: hero.jpg and hero.png both give hero.webp
          const { name, ext } = path.parse(output);
          let unique = `${name}${ext}`;
          for (let n = 2; used.has(unique); n++) unique = `${name}-${n}${ext}`;
          used.add(unique);
          entries.push({ name: unique, path: output });
        }
      }
      return entries;
    },
  };
}

export type Store = ReturnType<typeof createStore>;

const store = createStore();
export const getStore = (): Store => store;
