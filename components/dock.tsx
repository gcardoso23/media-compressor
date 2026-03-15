'use client';

import { AnimatePresence, motion } from 'motion/react';
import { zipUrl } from '@/lib/api.ts';
import type { Item } from '@/lib/files.ts';
import { formatBytes, formatSaving, plural } from '@/lib/format.ts';
import { smooth } from '@/lib/motion.ts';
import { AnimatedNumber } from './animated-number.tsx';

export interface DockProps {
  items: Item[];
  pending: number;
  busy: number;
  batch: { total: number; finished: number };
  onCompress: () => void;
}

const swap = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.3 },
};

// The bar along the bottom: what was saved, and what to do next.
export function Dock({ items, pending, busy, batch, onCompress }: DockProps) {
  const media = items.filter((item) => item.kind !== null);
  const done = media.filter((item) => item.status === 'done' && item.outcome);

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
  const total = media.reduce((sum, item) => sum + item.bytes, 0);

  // once everything is done, downloading is the thing left to do
  const finished = !busy && !pending;
  const ids = done.flatMap((item) => (item.id ? [item.id] : []));
  const progress = batch.total ? batch.finished / batch.total : 0;

  return (
    <motion.footer
      className="dock"
      initial={{ y: '110%' }}
      animate={{ y: 0 }}
      exit={{ y: '110%' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.span
        className="dock__progress"
        initial={false}
        animate={{ scaleX: busy ? progress : 0, opacity: busy ? 1 : 0 }}
        transition={smooth}
      />

      <div className="dock__summary">
        <AnimatePresence mode="wait" initial={false}>
          {done.length ? (
            <motion.div key="saved" className="dock__summary" {...swap}>
              <AnimatedNumber
                className="dock__figure figure"
                value={(1 - after / before) * 100}
                format={(value) => formatSaving(100, 100 - value)}
              />
              <span className="dock__text">
                <span>
                  {formatBytes(before)} down to {formatBytes(after)}
                </span>
                <span className="dock__sub">with the lightest version of each file</span>
              </span>
            </motion.div>
          ) : (
            <motion.span key="count" className="dock__text" {...swap}>
              {plural(media.length, 'file')}, {formatBytes(total)}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <motion.div className="dock__actions" layout transition={smooth}>
        <AnimatePresence mode="popLayout" initial={false}>
          {done.length > 0 && (
            <motion.a
              key="download"
              layout
              className={`btn ${finished ? 'btn--primary' : 'btn--ghost'}`}
              href={zipUrl(ids)}
              download
              {...swap}
            >
              Download all
            </motion.a>
          )}
          {(busy > 0 || pending > 0) && (
            <motion.button
              key="compress"
              layout
              className="btn btn--primary"
              type="button"
              disabled={busy > 0}
              onClick={onCompress}
              {...swap}
            >
              {busy > 0
                ? `Compressing ${Math.min(batch.finished + 1, batch.total)} of ${batch.total}`
                : `Compress ${plural(pending, 'file')}`}
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.footer>
  );
}
