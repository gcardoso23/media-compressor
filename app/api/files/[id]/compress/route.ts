import { handle } from '@/engine/server/http.ts';
import type { CompressEvent } from '@/engine/server/protocol.ts';
import { HttpError, getStore } from '@/engine/server/store.ts';

// Compresses an uploaded file with the settings in the JSON body, answering
// with one JSON event per line as the work goes on.
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async () => {
    const { id } = await params;
    const body: unknown = await request.json().catch(() => {
      throw new HttpError(400, 'The request body is not valid JSON');
    });
    const store = getStore();
    const { entry, config } = store.prepare(id, body);

    // closing the page or removing the file stops the encode
    const abort = new AbortController();
    request.signal.addEventListener('abort', () => abort.abort());
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: CompressEvent) => {
          if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        await store.compress(entry, config, send, abort.signal);
        if (!abort.signal.aborted) controller.close();
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  });
}
