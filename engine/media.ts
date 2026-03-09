import type { MediaKind } from './types.ts';

// Which files the tool reads. Free of Node imports: the interface uses it too.
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.svg']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.wmv', '.ogv']);

export function kindOf(name: string): MediaKind | null {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}
