import type { Flags } from '@/engine/server/protocol.ts';

// What can be chosen in the interface, per kind of media.

export type ResizeMode = 'none' | 'max-size' | 'width' | 'height' | 'scale';
export type ImageOutput = 'original' | 'webp' | 'avif';
export type VideoOutput = 'mp4' | 'webm';

export interface ImageChoice {
  kind: 'image';
  formats: ImageOutput[];
  quality: 'exact' | 'lossy';
  resize: ResizeMode;
  amount: number;
}

export interface VideoChoice {
  kind: 'video';
  formats: VideoOutput[];
  sound: 'keep' | 'remove';
  resize: ResizeMode;
  amount: number;
}

export type Choice = ImageChoice | VideoChoice;

export interface Choices {
  image: ImageChoice;
  video: VideoChoice;
}

export const DEFAULTS: Choices = {
  image: { kind: 'image', formats: ['original'], quality: 'exact', resize: 'none', amount: 1920 },
  video: { kind: 'video', formats: ['mp4'], sound: 'keep', resize: 'none', amount: 1920 },
};

export const RESIZE_MODES: [ResizeMode, string][] = [
  ['none', 'Original size'],
  ['max-size', 'Longest edge'],
  ['width', 'Width'],
  ['height', 'Height'],
  ['scale', 'Scale'],
];

// The flags the server takes for a choice: the same ones as the folder scripts.
export function toFlags(choice: Choice): Flags {
  const flags: Flags = { format: choice.formats.join(',') };
  if (choice.kind === 'image' && choice.quality === 'lossy') flags.lossy = true;
  if (choice.kind === 'video' && choice.sound === 'remove') flags['no-audio'] = true;
  if (choice.resize !== 'none' && choice.amount > 0) flags[choice.resize] = String(choice.amount);
  return flags;
}

const NAMES: Record<ImageOutput | VideoOutput, string> = {
  original: 'original format',
  webp: 'WebP',
  avif: 'AVIF',
  mp4: 'MP4',
  webm: 'WebM',
};

const listOf = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// A short description, e.g. "WebP, visually lossless, 50% size".
export function describe(choice: Choice): string {
  const parts = [listOf(choice.formats.map((format) => NAMES[format]))];
  if (choice.kind === 'image') parts.push(choice.quality === 'exact' ? 'exact pixels' : 'visually lossless');
  if (choice.kind === 'video' && choice.sound === 'remove') parts.push('no sound');
  if (choice.resize === 'scale') parts.push(`${choice.amount}% size`);
  else if (choice.resize !== 'none') {
    const label = RESIZE_MODES.find(([mode]) => mode === choice.resize)?.[1].toLowerCase();
    parts.push(`${label} ${choice.amount}px`);
  }
  return parts.join(', ');
}

const STORAGE_KEY = 'media-compressor:choices';

export function loadChoices(): Choices {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Choices> | null;
    return {
      image: { ...DEFAULTS.image, ...saved?.image, kind: 'image' },
      video: { ...DEFAULTS.video, ...saved?.video, kind: 'video' },
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveChoices(choices: Choices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // private windows can refuse storage; the choices just won't be remembered
  }
}
