import { fileResponse, handle } from '@/engine/server/http.ts';
import { getStore } from '@/engine/server/store.ts';

export const dynamic = 'force-dynamic';

// One output of one run. ?download makes the browser save it.
export function GET(request: Request, { params }: { params: Promise<{ id: string; run: string; name: string }> }) {
  return handle(request, async () => {
    const { id, run, name } = await params;
    const download = new URL(request.url).searchParams.has('download');
    return fileResponse(request, getStore().outputPath(id, run, name), { download });
  });
}
