import { isMissing, run } from '../utils/exec.ts';
import { hasFilter } from '../videos/ffmpeg.ts';
import type { Tools } from './protocol.ts';

// Which of the command-line tools the engine relies on are installed.
export async function tools(): Promise<Tools> {
  const present = async (bin: string) => {
    try {
      await run(bin, ['-version']);
      return true;
    } catch (error) {
      return !isMissing(error);
    }
  };
  const [ffmpeg, jpegtran] = await Promise.all([present('ffmpeg'), present('jpegtran')]);
  return { ffmpeg, jpegtran, vmaf: ffmpeg && (await hasFilter('libvmaf')) };
}
