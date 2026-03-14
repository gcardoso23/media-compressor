// What the local server and the interface say to each other. Type-only, so
// the browser code can import it without pulling in Node.
import type { MediaKind, Progress, Skipped, Written } from '../types.ts';

// Settings for one run, as flag name → value (the same flags the folder scripts take).
export type Flags = Record<string, string | boolean>;

export interface Uploaded {
  id: string;
  name: string;
  kind: MediaKind;
  bytes: number;
}

export interface Tools {
  ffmpeg: boolean;
  jpegtran: boolean;
  vmaf: boolean;
}

// A result as the browser sees it: a file name and a download URL instead of a path.
export type PublicResult =
  | (Omit<Written, 'output'> & { name: string; url: string })
  | (Omit<Skipped, 'output'> & { name: string; url?: undefined });

// One line of the streamed response to POST /api/files/:id/compress.
export type CompressEvent =
  | { type: 'queued' }
  | { type: 'started' }
  | ({ type: 'progress' } & Progress)
  | { type: 'done'; sourceBytes: number; warnings: string[]; results: PublicResult[] }
  | { type: 'error'; message: string };

export interface ErrorBody {
  error: string;
}
