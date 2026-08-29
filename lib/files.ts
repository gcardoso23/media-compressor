import type { MediaInfo } from '@/engine/estimate.ts';
import type { PublicResult } from '@/engine/server/protocol.ts';
import type { MediaKind, Progress } from '@/engine/types.ts';
import type { Choice } from './choices.ts';

// Where a file is on its way through the page.
export type Status =
  | 'reading' // being handed to the local server
  | 'ready' // waiting for "Compress"
  | 'waiting' // queued behind other files
  | 'working'
  | 'done'
  | 'error'
  | 'unsupported';

export interface Outcome {
  sourceBytes: number;
  results: PublicResult[];
  warnings: string[];
}

export interface Item {
  key: string;
  file: File;
  name: string;
  bytes: number;
  kind: MediaKind | null;
  // SVGs are optimised as SVGs, so there is nothing to choose for them
  vector: boolean;
  // the server's id, once the file is there
  id?: string;
  status: Status;
  error?: string;
  // its own settings instead of the shared ones
  custom?: Choice;
  // the flags its current results were made with, to tell when they're out of date
  ran?: string;
  progress?: Progress;
  // how far its current run is, from 0 to 1; never moves backwards
  fraction?: number;
  // its work in the current run against the plan: above 1 once a quality retry adds encodes
  scale?: number;
  outcome?: Outcome;
  preview?: string;
  // dimensions and length, for estimating the work
  media?: MediaInfo | null;
}

// Folders can be dropped too: every file inside them is added.
export async function filesFrom(transfer: DataTransfer): Promise<File[]> {
  const entries = [...transfer.items].map((entry) => entry.webkitGetAsEntry()).filter((entry) => entry !== null);
  if (!entries.length) return [...transfer.files];

  const found: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      found.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // entries arrive a batch at a time, and an empty batch means the end
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return found.filter((file) => !file.name.startsWith('.'));
}

// A frame from the start of a video, for its thumbnail. Null when the browser can't play it.
export function videoFrame(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const source = URL.createObjectURL(file);
    const finish = (url: string | null) => {
      URL.revokeObjectURL(source);
      clearTimeout(timer);
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), 5000);
    video.muted = true;
    video.preload = 'auto';
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(0.5, video.duration / 2 || 0);
    });
    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      const scale = 160 / Math.max(video.videoWidth, video.videoHeight, 1);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/jpeg', 0.8));
    });
    video.addEventListener('error', () => finish(null));
    video.src = source;
  });
}
