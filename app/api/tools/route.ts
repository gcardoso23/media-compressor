import { handle } from '@/engine/server/http.ts';
import { tools } from '@/engine/server/tools.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handle(request, async () => Response.json(await tools()));
}
