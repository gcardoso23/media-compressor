'use client';

import { AnimatePresence, motion } from 'motion/react';
import { zipUrl } from '@/lib/api.ts';
import { formatDuration } from '@/lib/estimate.ts';
import type { Item } from '@/lib/files.ts';
import { capitalise, formatBytes, formatSaving, plural } from '@/lib/format.ts';
import { EASE, smooth } from '@/lib/motion.ts';
import { AnimatedNumber } from './animated-number.tsx';

export interface DockProps {
  items: Item[];
  // files waiting for "Compress"
  pending: number;
  // files queued or being compressed
  busy: number;
  // the files of the current run, and how many of them are finished
  files: number;
  finished: number;
  // the whole run, from 0 to 1
  progress: number;
  // seconds left, once there is an estimate
  eta: number | null;
  // seconds the pending files are expected to take
  predicted: number;
  onCompress: () => void;
  onStop: () => void;
}

const swap = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.3 },
};

const percent = (value: number) => `${Math.floor(value)}%`;
const saving = (value: number) => formatSaving(100, 100 - value);

// The bar along the bottom: how the run is going, what was saved, and what to do next.
export function Dock({ items, pending, busy, files, finished: completed, progress, eta, predicted, onCompress, onStop }: DockProps) {
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

  let summary;
  if (busy) {
    summary = (
      <motion.div key="running" className="dock__summary" {...swap}>
        <AnimatedNumber className="dock__figure figure" value={progress * 100} format={percent} />
        <span className="dock__text">
          <span>
            Compressing {Math.min(completed + 1, files)} of {plural(files, 'file')}
          </span>
          <span className="dock__sub">{eta === null ? 'Working out the time left' : `About ${formatDuration(eta)} left`}</span>
        </span>
      </motion.div>
    );
  } else if (done.length) {
    summary = (
      <motion.div key="saved" className="dock__summary" {...swap}>
        <AnimatedNumber className="dock__figure figure" value={(1 - after / before) * 100} format={saving} />
        <span className="dock__text">
          <span>
            {formatBytes(before)} down to {formatBytes(after)}
          </span>
          <span className="dock__sub">with the lightest version of each file</span>
        </span>
      </motion.div>
    );
  } else {
    summary = (
      <motion.div key="count" className="dock__summary" {...swap}>
        <span className="dock__text">
          <span>
            {plural(media.length, 'file')}, {formatBytes(total)}
          </span>
          {pending > 0 && <span className="dock__sub">{capitalise(`about ${formatDuration(predicted)} to compress`)}</span>}
        </span>
      </motion.div>
    );
  }

  return (
    <motion.footer
      className="dock"
      initial={{ y: '110%' }}
      animate={{ y: 0 }}
      exit={{ y: '110%' }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <span className="dock__track" aria-hidden="true">
        <motion.span
          className="dock__progress"
          initial={false}
          animate={{ scaleX: busy ? progress : 0, opacity: busy ? 1 : 0 }}
          transition={{ scaleX: { duration: 0.6, ease: 'easeOut' }, opacity: smooth }}
        />
      </span>

      <div
        className="dock__status"
        role={busy ? 'progressbar' : undefined}
        aria-valuemin={busy ? 0 : undefined}
        aria-valuemax={busy ? 100 : undefined}
        aria-valuenow={busy ? Math.floor(progress * 100) : undefined}
      >
        <AnimatePresence mode="wait" initial={false}>
          {summary}
        </AnimatePresence>
      </div>

      <motion.div className="dock__actions" layout transition={smooth}>
        <AnimatePresence mode="popLayout" initial={false}>
          {busy > 0 && (
            <motion.button key="stop" layout className="btn btn--ghost" type="button" onClick={onStop} {...swap}>
              Stop
            </motion.button>
          )}
          {!busy && done.length > 0 && (
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
          {!busy && pending > 0 && (
            <motion.button key="compress" layout className="btn btn--primary" type="button" onClick={onCompress} {...swap}>
              Compress {plural(pending, 'file')}
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.footer>
  );
}
