import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { photo, tmpDir } from './helpers.ts';

const BIN = fileURLToPath(new URL('../bin/compress.ts', import.meta.url));
// resolved from here: the tests run the scripts from a temporary folder
const TSX = import.meta.resolve('tsx');

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs the folder scripts the way npm does, resolving instead of throwing.
const cli = (args: string[], cwd: string) =>
  new Promise<Ran>((resolve) => {
    execFile(process.execPath, ['--import', TSX, BIN, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });

async function project(t: TestContext) {
  const dir = await tmpDir(t);
  await mkdir(path.join(dir, 'input', 'nested'), { recursive: true });
  await photo(160, 120).png().toFile(path.join(dir, 'input', 'a.png'));
  await photo(160, 120, 4).png().toFile(path.join(dir, 'input', 'nested', 'b.png'));
  await writeFile(path.join(dir, 'input', 'notes.txt'), 'not media');
  return dir;
}

test('compresses ./input into ./output, mirroring folders', async (t) => {
  const dir = await project(t);
  const { code, stdout } = await cli(['images', '--webp'], dir);
  assert.equal(code, 0, stdout);
  assert.deepEqual((await readdir(path.join(dir, 'output'))).sort(), ['.media-compressor.json', 'a.png', 'a.webp', 'nested']);
  assert.deepEqual((await readdir(path.join(dir, 'output', 'nested'))).sort(), ['b.png', 'b.webp']);
});

test('a second run only redoes what changed', async (t) => {
  const dir = await project(t);
  await cli(['images'], dir);

  const again = await cli(['images'], dir);
  assert.match(again.stdout, /0 compressed, 2 up to date/);

  // different settings make the old outputs stale
  const resized = await cli(['images', '--scale', '50'], dir);
  assert.match(resized.stdout, /2 compressed/);

  const forced = await cli(['images', '--scale', '50', '--force'], dir);
  assert.match(forced.stdout, /2 compressed/);
});

test('--dry-run writes nothing', async (t) => {
  const dir = await project(t);
  const { code, stdout } = await cli(['all', '--webp', '--dry-run'], dir);
  assert.equal(code, 0);
  assert.match(stdout, /a\.webp/);
  assert.deepEqual(await readdir(dir), ['input']);
});

test('mistakes are reported with a non-zero exit code', async (t) => {
  const dir = await project(t);
  const cases: [string[], RegExp][] = [
    [['photos'], /Unknown command "photos"/],
    [['images', '--nope'], /Unknown option '--nope'/],
    [['images', '-f', 'bmp'], /Unknown output format: bmp/],
    [['images', '--scale', '150'], /--scale expects a number between 1 and 100/],
    [['images', '-q', '70'], /--quality only applies with --lossy/],
    [['images', 'missing-folder'], /Not found: missing-folder/],
    [['images', '-o', 'input'], /would overwrite its source/],
  ];
  for (const [args, message] of cases) {
    const { code, stderr } = await cli(args, dir);
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, message);
  }
});
