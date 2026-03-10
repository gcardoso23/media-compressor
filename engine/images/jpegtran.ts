import { isMissing, run } from '../utils/exec.ts';

let missing = false;

// Which markers to keep: none, only the colour profile, or everything (EXIF included).
export type CopyMarkers = 'none' | 'icc' | 'all';

// Rewrites a JPEG's entropy coding without touching its image data: the
// decoded pixels stay bit-identical. Resolves to null when jpegtran isn't installed.
export async function optimizeJpeg(input: Buffer, { copy = 'none' }: { copy?: CopyMarkers } = {}): Promise<Buffer | null> {
  if (missing) return null;
  const attempt = (extra: string[]) => run('jpegtran', ['-copy', copy, '-optimize', ...extra], { input });

  try {
    // progressive usually wins, but not on very small files
    const [progressive, baseline] = await Promise.all([attempt(['-progressive']), attempt([])]);
    return progressive.stdout.length <= baseline.stdout.length ? progressive.stdout : baseline.stdout;
  } catch (error) {
    if (!isMissing(error)) throw error;
    missing = true;
    return null;
  }
}
