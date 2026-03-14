import type { CompressEvent, ErrorBody, Flags, Tools, Uploaded } from '@/engine/server/protocol.ts';

// Calls from the page to its own API routes.

async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as ErrorBody;
    throw new Error(body.error);
  }
  return response;
}

export async function getTools(): Promise<Tools> {
  return (await request('/api/tools')).json() as Promise<Tools>;
}

export async function uploadFile(file: File, signal?: AbortSignal): Promise<Uploaded> {
  const response = await request(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, signal });
  return response.json() as Promise<Uploaded>;
}

// Compresses an uploaded file, yielding the server's events as they arrive.
export async function* compressFile(id: string, flags: Flags, signal?: AbortSignal): AsyncGenerator<CompressEvent> {
  const response = await request(`/api/files/${id}/compress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flags),
    signal,
  });
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += value;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line) yield JSON.parse(line) as CompressEvent;
  }
}

export function forgetFile(id: string): void {
  void fetch(`/api/files/${id}`, { method: 'DELETE' }).catch(() => {});
}

export const zipUrl = (ids: string[]) => `/api/zip?ids=${ids.join(',')}`;

// fetch fails with a TypeError when nothing answers at all
export function describeError(error: unknown): string {
  if (error instanceof TypeError) return "The local server isn't answering. Start it again with npm run dev, then try again.";
  return (error as Error).message;
}
