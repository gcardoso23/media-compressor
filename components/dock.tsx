'use client';

import { zipUrl } from '@/lib/api.ts';
import type { Item } from '@/lib/files.ts';
import { formatBytes, formatSaving, plural } from '@/lib/format.ts';

export interface DockProps {
  items: Item[];
  pending: number;
  busy: number;
  batch: { total: number; finished: number };
  onCompress: () => void;
}

// The bar along the bottom: what was saved, and what to do next.
export function Dock({ items, pending, busy, batch, onCompress }: DockProps) {
  const media = items.filter((item) => item.kind !== null);
  const done = media.filter((item) => item.status === 'done' && item.outcome);

  let summary;
  if (done.length) {
    let before = 0;
    let after = 0;
    for (const item of done) {
      if (!item.outcome) continue;
      // what a page would ship: the lightest version of each file
      const sizes = item.outcome.results.flatMap((result) =>
        result.url !== undefined && result.format !== 'poster' ? [result.bytes] : [],
      );
      before += item.outcome.sourceBytes;
      after += Math.min(item.outcome.sourceBytes, ...sizes);
    }
    summary = (
      <>
        <span className="dock__figure">{formatSaving(before, after)}</span>
        <span className="dock__text">
          <span>
            {formatBytes(before)} down to {formatBytes(after)}
          </span>
          <span className="dock__sub">with the lightest version of each file</span>
        </span>
      </>
    );
  } else {
    const bytes = media.reduce((total, item) => total + item.bytes, 0);
    summary = (
      <span className="dock__text">
        {plural(media.length, 'file')}, {formatBytes(bytes)}
      </span>
    );
  }

  // once everything is done, downloading is the thing left to do
  const finished = !busy && !pending;
  const ids = done.flatMap((item) => (item.id ? [item.id] : []));
  const progress = busy && batch.total ? batch.finished / batch.total : 0;

  return (
    <footer className="dock">
      {busy > 0 && <span className="dock__progress" style={{ transform: `scaleX(${progress})` }} />}
      <div className="dock__summary">{summary}</div>
      <div className="dock__actions">
        {done.length > 0 && (
          <a className={`btn ${finished ? 'btn--primary' : 'btn--ghost'}`} href={zipUrl(ids)} download>
            Download all
          </a>
        )}
        {(busy > 0 || pending > 0) && (
          <button className="btn btn--primary" type="button" disabled={busy > 0} onClick={onCompress}>
            {busy > 0 ? `Compressing ${Math.min(batch.finished + 1, batch.total)} of ${batch.total}` : `Compress ${plural(pending, 'file')}`}
          </button>
        )}
      </div>
    </footer>
  );
}
