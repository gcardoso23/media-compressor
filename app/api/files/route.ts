import { bodyStream, handle } from '@/engine/server/http.ts';
import { getStore } from '@/engine/server/store.ts';

// Takes one file as the raw request body, its name in ?name=.
export function POST(request: Request) {
  return handle(request, async () => {
    const name = new URL(request.url).searchParams.get('name') ?? '';
    const uploaded = await getStore().upload(name, bodyStream(request));
    return Response.json(uploaded, { status: 201 });
  });
}
