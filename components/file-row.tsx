'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { PublicResult } from '@/engine/server/protocol.ts';
import { type Choice, describe } from '@/lib/choices.ts';
import type { Item, Outcome } from '@/lib/files.ts';
import { capitalise, formatBytes, formatSaving } from '@/lib/format.ts';
import { EASE, slow, smooth, unfold } from '@/lib/motion.ts';
import { AnimatedNumber } from './animated-number.tsx';
import { Controls } from './controls.tsx';
import { DownloadIcon, RemoveIcon } from './icons.tsx';

const FORMAT_NAMES: Record<string, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  gif: 'GIF',
  svg: 'SVG',
  webp: 'WebP',
  avif: 'AVIF',
  mp4: 'MP4',
  webm: 'WebM',
  poster: 'Poster',
};

type Written = Extract<PublicResult, { url: string }>;

// A part of the row that opens and closes smoothly.
function Section({ show, id, children }: { show: boolean; id: string; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key={id} className="file__section" variants={unfold} initial="hidden" animate="shown" exit="gone">
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function verdict(item: Item, result: Written): { text: string; title?: string } {
  if (result.vmaf != null) {
    const ceiling = result.vmafCeiling == null ? '' : ` of ${result.vmafCeiling.toFixed(1)}`;
    return {
      text: `VMAF ${result.vmaf.toFixed(1)}${ceiling}`,
      title: 'Measured against the original. A perfect copy scores the higher number; people start to notice a drop of about 6.',
    };
  }
  if (result.note === 'already optimal') return { text: 'Already optimal, kept as it is' };
  if (result.note) return { text: capitalise(result.note) };
  if (result.format === 'poster') return { text: 'Still frame' };
  if (result.exact) return { text: item.kind === 'video' ? 'Identical streams' : 'Identical pixels' };
  return { text: 'Visually lossless' };
}

const lineMotion = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: smooth },
};

function ResultLine({ item, outcome, result }: { item: Item; outcome: Outcome; result: PublicResult }) {
  const label = <span className="line__format">{FORMAT_NAMES[result.format] ?? result.format}</span>;
  if (result.url === undefined) {
    const tip = result.tip === 'lossy' ? ' Visually lossless can make one.' : '';
    return (
      <motion.div className="line line--skipped" variants={lineMotion}>
        {label}
        <p className="line__reason">
          {capitalise(result.skipped)}.{tip}
        </p>
      </motion.div>
    );
  }

  const { text, title } = verdict(item, result);
  const poster = result.format === 'poster';
  const share = Math.min(1, result.bytes / outcome.sourceBytes);
  const saved = (1 - result.bytes / outcome.sourceBytes) * 100;
  return (
    <motion.div className="line" variants={lineMotion}>
      {label}
      {poster ? (
        <span />
      ) : (
        <span className="meter" aria-hidden="true">
          <motion.span
            className="meter__fill"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: share }}
            transition={{ ...slow, duration: 1.3, delay: 0.15 }}
          />
        </span>
      )}
      <span className="line__size">{formatBytes(result.bytes)}</span>
      {poster ? (
        <span />
      ) : (
        <AnimatedNumber
          className="line__saving figure"
          value={saved}
          format={(value) => formatSaving(100, 100 - value)}
        />
      )}
      <span className="line__verdict" title={title}>
        {text}
      </span>
      <a className="icon-btn" href={`${result.url}?download`} download={result.name} aria-label={`Download ${result.name}`}>
        <DownloadIcon />
      </a>
    </motion.div>
  );
}

// "crf 18, pass 1/2" is the encoder's wording, not something to show as it is.
const describeStage = (stage: string) =>
  stage.replace(/^crf \d+(?:, pass (\d)\/(\d))?$/, (_, pass?: string, passes?: string) =>
    pass ? `encoding, pass ${pass} of ${passes}` : 'encoding',
  );

// What the file is doing right now, in a few words. The bar for the whole run is in the dock.
function statusOf(item: Item): string | null {
  if (item.status === 'reading') return 'Reading';
  if (item.status === 'waiting') return 'Waiting';
  if (item.status !== 'working') return null;
  if (!item.progress) return item.kind === 'video' ? 'Starting' : 'Compressing';
  const { format, stage, ratio } = item.progress;
  const text = `${FORMAT_NAMES[format] ?? format}: ${describeStage(stage)}`;
  // videos report how far each pass is, once it has a position; images report
  // each output as it starts
  return item.kind === 'video' && ratio > 0 ? `${text}, ${Math.round(ratio * 100)}%` : text;
}

export interface FileRowProps {
  item: Item;
  // the settings it will be compressed with, when there are any to choose
  choice: Choice | null;
  canCustomise: boolean;
  open: boolean;
  // its results were made with settings that have since changed
  stale: boolean;
  onToggle: () => void;
  onChange: (choice: Choice) => void;
  onReset: () => void;
  onRemove: () => void;
  onRetry: () => void;
}

// One file: its name, its own settings if it has any, its progress and its results.
export function FileRow({ item, choice, canCustomise, open, stale, onToggle, onChange, onReset, onRemove, onRetry }: FileRowProps) {
  const sized = item.outcome?.results.find((result): result is Written => result.url !== undefined && Boolean(result.width));
  const meta = [formatBytes(item.bytes), sized && `${sized.width} × ${sized.height}`].filter(Boolean).join(', ');
  const dot = item.name.lastIndexOf('.');
  const busy = item.status === 'working' || item.status === 'waiting';
  const status = statusOf(item);

  let note: ReactNode = null;
  if (item.status === 'unsupported') note = item.error;
  else if (item.vector) note = 'Vector: optimised as SVG, nothing to set.';
  else if (item.custom && !open) {
    note = (
      <>
        Own settings: {describe(item.custom)}.{' '}
        <button className="btn btn--link" type="button" onClick={onReset}>
          Use shared settings
        </button>
      </>
    );
  }

  return (
    <motion.article
      className="file"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      // folds its height away, so the rows below slide up into place
      exit={{
        opacity: 0,
        height: 0,
        paddingTop: 0,
        paddingBottom: 0,
        transition: { duration: 0.45, ease: EASE, opacity: { duration: 0.2 } },
      }}
      transition={smooth}
    >
      <div className="thumb">
        <AnimatePresence initial={false}>
          {item.preview ? (
            // a local object URL: next/image has nothing to optimise here
            // eslint-disable-next-line @next/next/no-img-element
            <motion.img key="preview" src={item.preview} alt="" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={smooth} />
          ) : (
            <span className="thumb__ext">{dot === -1 ? '' : item.name.slice(dot + 1, dot + 5).toLowerCase()}</span>
          )}
        </AnimatePresence>
      </div>

      <div className="file__main">
        <div className="file__head">
          <div className="file__title">
            <h3 className="file__name">{item.name}</h3>
            <p className="file__meta">{meta}</p>
          </div>
          <div className="file__actions">
            {canCustomise && (
              <button className="btn btn--text" type="button" aria-expanded={open} onClick={onToggle}>
                {open ? 'Done' : item.custom ? 'Edit' : 'Customise'}
              </button>
            )}
            <button className="icon-btn icon-btn--quiet" type="button" aria-label={`Remove ${item.name}`} onClick={onRemove}>
              <RemoveIcon />
            </button>
          </div>
        </div>

        <Section show={Boolean(note)} id="note">
          <div className="file__note">{note}</div>
        </Section>

        <Section show={open && Boolean(choice)} id="panel">
          {choice && (
            <div className="panel">
              <Controls choice={choice} onChange={onChange} />
              {item.custom && (
                <button className="btn btn--link panel__reset" type="button" onClick={onReset}>
                  Use shared settings
                </button>
              )}
            </div>
          )}
        </Section>

        <Section show={item.status === 'error'} id="error">
          <div className="status status--error">
            <span className="status__text">
              <span>{item.error ?? 'Something went wrong.'}</span>
              <button className="btn btn--link" type="button" onClick={onRetry}>
                Try again
              </button>
            </span>
          </div>
        </Section>

        <Section show={status !== null} id="status">
          <p className="status status__text">
            <span className="status__dot" aria-hidden="true" />
            {status}
          </p>
        </Section>

        <Section show={Boolean(item.outcome)} id="results">
          {item.outcome && (
            // results from older settings stay visible, dimmed, until they are redone
            <motion.div
              // a new key per run replays the lines arriving
              key={item.outcome.results[0]?.url ?? item.ran}
              className={`results${stale || busy ? ' is-stale' : ''}`}
              initial="hidden"
              animate="shown"
              variants={{ shown: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } } }}
            >
              {item.outcome.results.map((result) => (
                <ResultLine key={result.name + result.format} item={item} outcome={item.outcome as Outcome} result={result} />
              ))}
              {item.outcome.warnings.map((warning) => (
                <motion.p key={warning} className="warning" variants={lineMotion}>
                  {capitalise(warning)}
                </motion.p>
              ))}
            </motion.div>
          )}
        </Section>
      </div>
    </motion.article>
  );
}
