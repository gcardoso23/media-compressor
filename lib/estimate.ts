import { imageCost, videoCost } from '@/engine/estimate.ts';
import type { MediaKind, Resize } from '@/engine/types.ts';
import type { Choice, Choices } from './choices.ts';
import type { Item } from './files.ts';

// Work in the engine's reference seconds, by kind of file.
export type Work = Record<MediaKind, number>;

export const noWork = (): Work => ({ image: 0, video: 0 });

// The engine's resize limits for a choice.
export function resizeOf(choice: Choice): Partial<Resize> {
  switch (choice.resize) {
    case 'max-size':
      return { maxSize: choice.amount };
    case 'width':
      return { width: choice.amount };
    case 'height':
      return { height: choice.amount };
    case 'scale':
      return { scale: choice.amount };
    default:
      return {};
  }
}

// How much work a file is, in the engine's reference seconds.
export function costOf(item: Item, shared: Choices): number {
  if (!item.kind) return 0;
  if (item.vector) return 0.05;
  const choice = item.custom ?? shared[item.kind];
  // unreadable dimensions: fall back on the file size
  if (!item.media) return (item.bytes / 1e6) * (item.kind === 'video' ? 2 : 0.3);
  if (choice.kind === 'image') {
    return imageCost(item.name, item.media, { formats: choice.formats, lossy: choice.quality === 'lossy', resize: resizeOf(choice) });
  }
  return videoCost(item.media, { formats: choice.formats, webmCodec: 'vp9', check: true, resize: resizeOf(choice) });
}

// How much of a file is done, from 0 to 1.
export function fractionOf(item: Item): number {
  if (item.status === 'done' || item.status === 'error') return 1;
  if (item.status === 'working') return item.fraction ?? 0;
  return 0;
}

// Several images compress at once, but each one already uses every core, so
// running them side by side only gains a little.
const OVERLAP = 1.2;

// How long work takes once spread over the machine, in reference seconds.
// Videos compress one after another while images go alongside them, so a run
// lasts as long as its videos, unless everything together takes longer.
export function pacing(total: Work): (work: Work) => number {
  const byVideos = total.video * OVERLAP >= total.image + total.video;
  return byVideos ? (work) => work.video : (work) => (work.image + work.video) / OVERLAP;
}

export interface RunState {
  // the bar, from 0 to 1: the share of the planned work done, never moving back
  progress: number;
  // work done and left, paced, for the time left
  done: number;
  left: number;
  files: number;
  finished: number;
}

// Where a run stands. `costs` holds the planned work of each file in it.
export function measureRun(items: Item[], costs: Record<string, number>): RunState {
  const done = noWork();
  const left = noWork();
  let planned = 0;
  let completed = 0;
  let files = 0;
  let finished = 0;
  for (const item of items) {
    const cost = costs[item.key];
    if (cost === undefined || !item.kind) continue;
    planned += cost;
    completed += cost * fractionOf(item);
    files++;
    if (item.status === 'done' || item.status === 'error') finished++;
    // a failed file's time says nothing about the rest
    if (item.status === 'error') continue;
    // unlike the bar, this follows a retry: the work grows and the share done dips
    const work = cost * (item.scale ?? 1);
    const share = item.status === 'done' ? 1 : item.status === 'working' ? (item.progress?.overall ?? 0) : 0;
    done[item.kind] += work * share;
    left[item.kind] += work * (1 - share);
  }
  const pace = pacing({ image: done.image + left.image, video: done.video + left.video });
  return { progress: planned > 0 ? Math.min(1, completed / planned) : 0, done: pace(done), left: pace(left), files, finished };
}

const SPEED_KEY = 'media-compressor:speed';

// Seconds per paced reference second on this machine, learned from earlier runs.
export function speed(): number {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

// Folds a finished run into the learned speed: it took `seconds` for `paced` work.
export function learnSpeed(seconds: number, paced: number): void {
  if (seconds < 3 || paced <= 0) return;
  const next = speed() * 0.5 + (seconds / paced) * 0.5;
  try {
    localStorage.setItem(SPEED_KEY, String(Math.min(20, Math.max(0.05, next))));
  } catch {
    // nothing to remember it in
  }
}

// Expected seconds for this much work on this machine.
export const predict = (work: Work) => pacing(work)(work) * speed();

// Seconds left, from the learned speed at first and from the pace measured in
// this run as it gets going. `rate` is the learned speed when the run started.
export function remaining({ done, left, elapsed, rate }: { done: number; left: number; elapsed: number; rate: number }): number {
  if (left <= 0) return 0;
  const fromSpeed = left * rate;
  const progress = done / (done + left);
  if (progress < 0.02) return fromSpeed;
  const fromPace = (elapsed * left) / done;
  // lean fully on the measured pace once a fifth is done
  const trust = Math.min(1, progress / 0.2);
  return trust * fromPace + (1 - trust) * fromSpeed;
}

export function formatDuration(seconds: number): string {
  if (seconds < 10) return 'a few seconds';
  if (seconds < 55) return `${Math.max(10, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 90) return 'a minute';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}
