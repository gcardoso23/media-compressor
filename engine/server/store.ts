import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import defaults from '../../media.config.ts';
import { compressImage } from '../images/compress.ts';
import { kindOf } from '../media.ts';
import { OPTIONS, applyFlags } from '../options.ts';
import { planJobs } from '../plan.ts';
import { type Config, type MediaKind, isSkipped } from '../types.ts';
import { limiter } from '../utils/pool.ts';
import { compressVideo } from '../videos/compress.ts';
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

// What the interface works with: uploaded sources and their latest outputs,
// kept in a temporary folder that is removed when the process exits.
function createStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'media-compressor-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));

  const files = new Map<string, Entry>();
  // sharp is multi-threaded per image and ffmpeg per video, so videos run one at a time
  const slots: Record<MediaKind, ReturnType<typeof limiter>> = { image: limiter(3), video: limiter(1) };

  const entryFor = (id: string) => {
    const entry = files.get(id);
    if (!entry) throw new HttpError(404, 'That file is no longer on the server. Add it again.');
    return entry;
  };

  return {
    async upload(rawName: string, body: Readable): Promise<Uploaded> {
      const name = path.basename(rawName).replace(/[\\/:\0]/g, '_');
      const kind = name ? kindOf(name) : null;
      if (!kind) throw new HttpError(415, `${name || 'This file'} is not an image or video this tool can read`);

      const id = randomUUID().slice(0, 8);
      const dir = path.join(root, id);
      const source = path.join(dir, 'source', name);
      await mkdir(path.dirname(source), { recursive: true });
      await pipeline(body, createWriteStream(source));
      files.set(id, { id, name, kind, dir, source, outputs: [], runs: 0, queue: Promise.resolve() });
      return { id, name, kind, bytes: (await stat(source)).size };
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
        slots[entry.kind](async () => {
          if (signal.aborted) return;
          send({ type: 'started' });

          // every run gets its own folder, so a download never reads a half-written file
          const run = ++entry.runs;
          const outDir = path.join(entry.dir, `out-${run}`);
          const [job] = planJobs([{ file: entry.source, rel: entry.name }], { outDir, config, kinds: [entry.kind] });
          if (!job) throw new Error(`${entry.name} has nothing to compress`);
          const { sourceBytes, results, warnings = [] } =
            entry.kind === 'image'
              ? await compressImage(job, { ...config.images, skipLarger: config.skipLarger })
              : await compressVideo(job, config, { signal, onProgress: (progress) => send({ type: 'progress', ...progress }) });

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
      files.delete(id);
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
        for (const output of files.get(id)?.outputs ?? []) {
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

// One store per process. Kept on globalThis because Next.js re-evaluates
// modules in development, and uploads must survive that.
const KEY = Symbol.for('media-compressor.store');
const holder = globalThis as typeof globalThis & { [KEY]?: Store };

export const getStore = (): Store => (holder[KEY] ??= createStore());
