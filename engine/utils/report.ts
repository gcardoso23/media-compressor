import path from 'node:path';
import { styleText } from 'node:util';
import { type Job, type Progress, type Result, isSkipped } from '../types.ts';

type Style = Parameters<typeof styleText>[0];

const tty = Boolean(process.stdout.isTTY);
const useColor = tty && !process.env.NO_COLOR;
const paint = (style: Style, text: string) => (useColor ? styleText(style, text) : text);

export function formatBytes(bytes: number): string {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 1e4 ? 1 : 0)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 2 : 1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function formatSaving(before: number, after: number): string {
  const percent = Math.round((1 - after / before) * 100);
  if (percent === 0) return '0%';
  return percent > 0 ? `-${percent}%` : `+${-percent}%`;
}

// Terminal output for the folder scripts.
export function createReporter() {
  const started = performance.now();
  const totals = new Map<string, { files: number; before: number; after: number }>();
  const counts = { done: 0, upToDate: 0, failed: 0 };
  const tips = new Set<string>();

  const clearProgress = () => {
    if (tty) process.stdout.write('\r\x1b[2K');
  };

  return {
    counts,

    done(job: Job, sourceBytes: number, results: Result[], warnings: string[] = []) {
      counts.done++;
      const lines = [`${paint('bold', job.rel)}  ${paint('dim', formatBytes(sourceBytes))}`];
      const width = Math.max(...results.map((result) => path.basename(result.output).length));

      for (const result of results) {
        const name = path.basename(result.output).padEnd(width);
        if (isSkipped(result)) {
          if (result.tip) tips.add(result.tip);
          lines.push(`  ${paint('yellow', '-')} ${name}  ${paint('dim', `skipped: ${result.skipped}`)}`);
          continue;
        }
        const size = formatBytes(result.bytes).padStart(8);
        const dimensions = result.width ? `  ${result.width}×${result.height}` : '';
        // "of" appears when a perfect copy of this footage wouldn't score 100 either
        const ceiling = result.vmafCeiling == null ? '' : ` of ${result.vmafCeiling.toFixed(1)}`;
        const score = result.vmaf == null ? '' : `  VMAF ${result.vmaf.toFixed(1)}${ceiling}`;
        // conversions are written even when they lose, so they need calling out
        const remark = result.note ?? (result.bytes > sourceBytes ? 'larger than source' : null);
        const note = remark ? `  ${paint('dim', `(${remark})`)}` : '';
        // a poster is a new file, not a smaller version of the video
        if (result.format === 'poster') {
          lines.push(`  ${paint('green', '✓')} ${name}  ${size}       ${paint('dim', dimensions.trim())}`);
          continue;
        }
        const saving = formatSaving(sourceBytes, result.bytes).padStart(5);
        const coloured = paint(result.bytes < sourceBytes ? 'green' : 'yellow', saving);
        lines.push(`  ${paint('green', '✓')} ${name}  ${size}  ${coloured}${paint('dim', dimensions)}${score}${note}`);

        const total = totals.get(result.format) ?? { files: 0, before: 0, after: 0 };
        total.files++;
        total.before += sourceBytes;
        total.after += result.bytes;
        totals.set(result.format, total);
      }
      for (const warning of warnings) lines.push(`  ${paint('yellow', `! ${warning}`)}`);

      clearProgress();
      console.log(lines.join('\n'));
    },

    upToDate(job: Job) {
      counts.upToDate++;
      clearProgress();
      console.log(paint('dim', `${job.rel}  up to date`));
    },

    failed(job: Job, error: unknown) {
      counts.failed++;
      clearProgress();
      console.log(`${paint('bold', job.rel)}\n  ${paint('red', `✗ ${(error as Error).message}`)}`);
    },

    progress(job: Job, { format, stage, ratio }: Progress) {
      if (!tty) return;
      process.stdout.write(`\r\x1b[2K${paint('dim', `${job.rel} → ${format}  ${stage}  ${Math.round(ratio * 100)}%`)}`);
    },

    summary(outDir: string) {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const parts = [`${counts.done} compressed`];
      if (counts.upToDate) parts.push(`${counts.upToDate} up to date (--force to redo)`);
      if (counts.failed) parts.push(paint('red', `${counts.failed} failed`));
      console.log(`\n${parts.join(', ')} in ${seconds}s`);

      for (const [format, total] of totals) {
        const files = `${total.files} ${total.files === 1 ? 'file' : 'files'}`;
        console.log(
          `  ${format.padEnd(5)} ${files.padStart(9)}  ${formatBytes(total.before).padStart(8)} → ${formatBytes(total.after).padStart(8)}  ${formatSaving(total.before, total.after)}`,
        );
      }
      if (tips.has('lossy')) {
        console.log(
          `\n${paint('dim', 'Some WebP / AVIF files were skipped: a pixel-exact copy of an already lossy image (a JPEG, say)\nis bigger than the image itself. --lossy writes visually lossless ones instead.')}`,
        );
      }
      if (counts.done) console.log(`\n→ ${outDir}`);
    },
  };
}
