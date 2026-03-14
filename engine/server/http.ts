import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { statOrNull } from '../utils/fs.ts';
import { HttpError } from './store.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostname = (value: string) => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
};

// Only this machine's browser may use the API: a page on another site must
// not reach it, including by pointing its own hostname at 127.0.0.1.
export function guard(request: Request): Response | null {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const origin = request.headers.get('origin');
  if (!LOCAL_HOSTS.has(hostname(host)) || (origin && !LOCAL_HOSTS.has(hostname(origin)))) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

// Runs a route handler with the guard in front and errors turned into JSON.
export async function handle(request: Request, work: () => Promise<Response>): Promise<Response> {
  const blocked = guard(request);
  if (blocked) return blocked;
  try {
    return await work();
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return Response.json({ error: (error as Error).message }, { status });
  }
}

// A request body as a Node stream, for writing straight to disk.
export function bodyStream(request: Request): Readable {
  if (!request.body) throw new HttpError(400, 'The request has no file in it');
  return Readable.fromWeb(request.body as unknown as NodeWebStream<Uint8Array>);
}

const TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const toWeb = (stream: Readable) => Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

// A file as a response, honouring Range so videos can be played and seeked.
export async function fileResponse(request: Request, file: string, { download = false } = {}): Promise<Response> {
  const info = await statOrNull(file);
  if (!info?.isFile()) throw new HttpError(404, 'Not found');

  const headers = new Headers({
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (download) headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    // "bytes=-500" asks for the last 500 bytes
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(toWeb(createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers.set('Content-Length', String(info.size));
  return new Response(toWeb(createReadStream(file)), { headers });
}

export { toWeb };
