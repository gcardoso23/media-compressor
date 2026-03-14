import { handle } from '@/engine/server/http.ts';
import { getStore } from '@/engine/server/store.ts';

export function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async () => {
    const { id } = await params;
    await getStore().remove(id);
    return Response.json({});
  });
}
