import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { POST as compressRoute } from '../app/api/files/[id]/compress/route.ts';
import { GET as outputRoute } from '../app/api/files/[id]/runs/[run]/[name]/route.ts';
import { DELETE as removeRoute } from '../app/api/files/[id]/route.ts';
import { POST as uploadRoute } from '../app/api/files/route.ts';
import { GET as toolsRoute } from '../app/api/tools/route.ts';
import { GET as zipRoute } from '../app/api/zip/route.ts';
import { samePixels } from '../engine/images/pixels.ts';
import type { CompressEvent, ErrorBody, Flags, PublicResult, Uploaded } from '../engine/server/protocol.ts';
import { photo } from './helpers.ts';

// The route handlers are called directly, the way Next.js calls them.
const BASE = 'http://localhost:3000';
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function upload(name: string, body: Buffer | string) {
  const bytes = typeof body === 'string' ? body : new Uint8Array(body);
  const request = new Request(`${BASE}/api/files?name=${encodeURIComponent(name)}`, { method: 'POST', body: new Blob([bytes]) });
  const response = await uploadRoute(request);
  return { status: response.status, body: (await response.json()) as Uploaded & ErrorBody };
}

type Done = Extract<CompressEvent, { type: 'done' }>;

async function compress(id: string, flags: Flags) {
  const request = new Request(`${BASE}/api/files/${id}/compress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flags),
  });
  const response = await compressRoute(request, params({ id }));
  if (!response.ok) return { status: response.status, body: (await response.json()) as ErrorBody, events: [], done: undefined };
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CompressEvent);
  const done = events.find((event): event is Done => event.type === 'done');
  return { status: response.status, body: undefined, events, done };
}

type Written = Extract<PublicResult, { url: string }>;
const written = (done: Done | undefined) => (done?.results ?? []).filter((result): result is Written => result.url !== undefined);

// Fetches an output by the URL the compress route handed out.
function download(url: string, headers?: HeadersInit) {
  const [, , , id = '', , run = '', name = ''] = new URL(url, BASE).pathname.split('/');
  return outputRoute(new Request(`${BASE}${url}`, { headers }), params({ id, run, name: decodeURIComponent(name) }));
}

test('a file goes in, is compressed, and comes back identical and smaller', async () => {
  const source = await photo(240, 160, 4).png().toBuffer();

  const { status, body: file } = await upload('photo.png', source);
  assert.equal(status, 201);
  assert.deepEqual({ name: file.name, kind: file.kind, bytes: file.bytes }, { name: 'photo.png', kind: 'image', bytes: source.length });
  // what the interface needs to estimate the work
  assert.deepEqual(file.media, { width: 240, height: 160, frames: 1 });

  const { events, done } = await compress(file.id, { format: 'original,webp' });
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type !== 'progress'),
    ['queued', 'started', 'done'],
  );
  // one as each output starts
  assert.equal(events.filter((event) => event.type === 'progress').length, 2);
  const results = written(done);
  assert.deepEqual(results.map((result) => [result.name, result.exact]), [['photo.png', true], ['photo.webp', true]]);

  const raw = (buffer: Buffer) => sharp(buffer).ensureAlpha().raw().toBuffer();
  for (const result of results) {
    const response = await download(`${result.url}?download`);
    const data = Buffer.from(await response.arrayBuffer());
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(data.length, result.bytes);
    assert.ok(result.bytes < source.length);
    assert.ok(samePixels(await raw(source), await raw(data)));
  }

  const zip = Buffer.from(await (await zipRoute(new Request(`${BASE}/api/zip?ids=${file.id}`))).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  // the end record carries the number of files
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);

  const removed = await removeRoute(new Request(`${BASE}/api/files/${file.id}`, { method: 'DELETE' }), params({ id: file.id }));
  assert.equal(removed.status, 200);
  assert.equal((await download(results[0]?.url ?? '')).status, 404);
});

test('outputs can be fetched in ranges, so videos can be seeked', async () => {
  const { body: file } = await upload('photo.png', await photo(120, 80).png().toBuffer());
  const [result] = written((await compress(file.id, { format: 'original' })).done);
  const response = await download(result?.url ?? '', { Range: 'bytes=0-9' });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 10);
  assert.equal(response.headers.get('content-range'), `bytes 0-9/${result?.bytes}`);
});

test('the same flags as the folder scripts apply, and bad ones are refused', async () => {
  const { body: file } = await upload('photo.png', await photo(240, 160).png().toBuffer());

  const half = await compress(file.id, { scale: '50', lossy: true, out: '/somewhere/else' });
  const [result] = written(half.done);
  assert.deepEqual([result?.width, result?.height, result?.exact], [120, 80, false]);

  const bad = await compress(file.id, { scale: '500' });
  assert.equal(bad.status, 400);
  assert.match(bad.body?.error ?? '', /--scale expects a number between 1 and 100/);
});

test('files that are not media are turned away with a reason', async () => {
  const { status, body } = await upload('notes.txt', 'hello');
  assert.equal(status, 415);
  assert.match(body.error, /notes\.txt is not an image or video/);
  assert.equal((await compress('missing', {})).status, 404);
});

test('other sites cannot reach the API through a borrowed hostname', async () => {
  const tools = (headers: HeadersInit) => toolsRoute(new Request(`${BASE}/api/tools`, { headers }));
  assert.equal((await tools({ Host: 'localhost:3000' })).status, 200);
  assert.equal((await tools({ Host: 'evil.example' })).status, 403);
  assert.equal((await tools({ Host: 'localhost:3000', Origin: 'http://evil.example' })).status, 403);
});

test('output names cannot climb out of their folder', async () => {
  // only photo.webp is written, so reaching photo.png would mean reading the source
  const { body: file } = await upload('photo.png', await photo(60, 40).png().toBuffer());
  await compress(file.id, { format: 'webp' });
  const response = await outputRoute(
    new Request(`${BASE}/api/files/${file.id}/runs/1/x`),
    params({ id: file.id, run: '1', name: '../source/photo.png' }),
  );
  assert.equal(response.status, 404);
});
