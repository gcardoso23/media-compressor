import { readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { Source } from '../plan.ts';

const IGNORED_DIRS = new Set(['node_modules', '.git']);

export async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Every file under `dir`, sorted, skipping dotfiles and anything inside `exclude`.
export async function walk(dir: string, exclude: string[] = []): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || exclude.includes(full)) continue;
      found.push(...(await walk(full, exclude)));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

// Expands the given files / directories into sources, each with the path it
// keeps inside the output directory.
export async function collectSources(inputs: string[], outDir: string): Promise<Source[]> {
  const sources: Source[] = [];
  for (const input of inputs) {
    const root = path.resolve(input);
    const info = await statOrNull(root);
    if (!info) throw new Error(`Not found: ${input}`);
    if (info.isDirectory()) {
      for (const file of await walk(root, [outDir])) {
        sources.push({ file, rel: path.relative(root, file) });
      }
    } else {
      sources.push({ file: root, rel: path.basename(root) });
    }
  }
  return sources;
}
