import { PassThrough } from 'node:stream';
import { handle, toWeb } from '@/engine/server/http.ts';
import { HttpError, getStore } from '@/engine/server/store.ts';
import { writeZip } from '@/engine/server/zip.ts';

export const dynamic = 'force-dynamic';

// The latest outputs of the files in ?ids=, as one ZIP.
export function GET(request: Request) {
  return handle(request, async () => {
    const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean);
    const entries = getStore().zipEntries(ids);
    if (!entries.length) throw new HttpError(404, 'Nothing to download yet');

    const out = new PassThrough();
    writeZip(out, entries).catch((error: unknown) => out.destroy(error as Error));
    return new Response(toWeb(out), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="compressed.zip"' },
    });
  });
}
