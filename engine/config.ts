import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import defaults from '../media.config.ts';
import type { Config } from './types.ts';

const OWN_CONFIG = fileURLToPath(new URL('../media.config.ts', import.meta.url));

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Deep-merges `override` into a copy of `base`. Arrays are replaced, not merged.
export function merge<T extends object>(base: T, override?: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isObject(value) && isObject(current) ? merge(current, value) : value;
  }
  return out as T;
}

// The project's media.config.ts is the baseline. A media.config.ts (or .js) in
// the directory you run from, or --config, is layered on top of it.
export async function loadConfig(configPath?: string): Promise<Config> {
  const base = structuredClone(defaults);
  const candidates = configPath ? [configPath] : ['media.config.ts', 'media.config.js'];
  const file = candidates.map((name) => path.resolve(name)).find((candidate) => existsSync(candidate));

  if (!file) {
    if (configPath) throw new Error(`Config file not found: ${configPath}`);
    return base;
  }
  if (file === OWN_CONFIG) return base;
  const loaded = (await import(pathToFileURL(file).href)) as { default?: DeepPartial<Config> };
  return merge(base, loaded.default);
}
