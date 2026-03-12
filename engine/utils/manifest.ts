import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Job, type MediaKind, type Result, isSkipped } from '../types.ts';
import { statOrNull } from './fs.ts';

const FILE = '.media-compressor.json';

interface Entry {
  mtimeMs: number;
  size: number;
  settings: string;
  outputs: string[];
}

// Remembers what each source produced and with which settings, so a re-run
// only touches sources that changed. Lives in the output directory.
export async function openManifest(outDir: string, settings: Record<MediaKind, unknown>) {
  const file = path.join(outDir, FILE);
  let entries: Record<string, Entry> = {};
  try {
    entries = JSON.parse(await readFile(file, 'utf8')) as Record<string, Entry>;
  } catch {
    // first run, or an unreadable manifest: everything is simply redone
  }

  const fingerprint = (job: Job) =>
    createHash('sha1')
      .update(JSON.stringify([settings[job.kind], job.outputs, job.poster]))
      .digest('hex');

  return {
    async isCurrent(job: Job): Promise<boolean> {
      const entry = entries[job.source];
      if (!entry || entry.settings !== fingerprint(job)) return false;
      const source = await stat(job.source);
      if (entry.mtimeMs !== source.mtimeMs || entry.size !== source.size) return false;
      const written = await Promise.all(entry.outputs.map((output) => statOrNull(path.join(outDir, output))));
      return written.every(Boolean);
    },

    async record(job: Job, results: Result[]): Promise<void> {
      const source = await stat(job.source);
      entries[job.source] = {
        mtimeMs: source.mtimeMs,
        size: source.size,
        settings: fingerprint(job),
        outputs: results.filter((result) => !isSkipped(result)).map((result) => path.relative(outDir, result.output)),
      };
    },

    async save(): Promise<void> {
      await mkdir(outDir, { recursive: true });
      await writeFile(file, JSON.stringify(entries, null, 2));
    },
  };
}
