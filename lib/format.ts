export function formatBytes(bytes: number): string {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 1e4 ? 1 : 0)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 2 : 1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

// "−35%" for a saving, "+6%" when the file grew.
export function formatSaving(before: number, after: number): string {
  const percent = Math.round((1 - after / before) * 100);
  if (percent === 0) return '0%';
  return percent > 0 ? `−${percent}%` : `+${-percent}%`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
