import { spawn } from 'node:child_process';

export interface RunOptions {
  // piped to stdin
  input?: Buffer;
  // receives stdout chunks as they arrive instead of buffering them
  onStdout?: (chunk: Buffer) => void;
  cwd?: string;
  // aborting it kills the process
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

// Runs a command. Rejects with the tail of stderr when it exits non-zero, and
// with the spawn error (code ENOENT) when it isn't installed.
export function run(bin: string, args: string[], { input, onStdout, cwd, signal }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, signal, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => (onStdout ? onStdout(chunk) : stdout.push(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `${bin} exited with code ${code}`));
    });

    if (input && child.stdin) {
      // the process may exit before reading everything; `close` reports that
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// True for the error a missing executable produces.
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
