'use client';

import type { PublicResult } from '@/engine/server/protocol.ts';
import { type Choice, describe } from '@/lib/choices.ts';
import type { Item, Outcome } from '@/lib/files.ts';
import { capitalise, formatBytes, formatSaving } from '@/lib/format.ts';
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

function ResultLine({ item, outcome, result }: { item: Item; outcome: Outcome; result: PublicResult }) {
  const label = <span className="line__format">{FORMAT_NAMES[result.format] ?? result.format}</span>;
  if (result.url === undefined) {
    const tip = result.tip === 'lossy' ? ' Visually lossless can make one.' : '';
    return (
      <div className="line line--skipped">
        {label}
        <p className="line__reason">
          {capitalise(result.skipped)}.{tip}
        </p>
      </div>
    );
  }

  const { text, title } = verdict(item, result);
  const poster = result.format === 'poster';
  const share = Math.min(1, result.bytes / outcome.sourceBytes);
  return (
    <div className="line">
      {label}
      {poster ? (
        <span />
      ) : (
        <span className="meter" aria-hidden="true">
          <span className="meter__fill" style={{ transform: `scaleX(${share})` }} />
        </span>
      )}
      <span className="line__size">{formatBytes(result.bytes)}</span>
      <span className="line__saving">{poster ? '' : formatSaving(outcome.sourceBytes, result.bytes)}</span>
      <span className="line__verdict" title={title}>
        {text}
      </span>
      <a className="icon-btn" href={`${result.url}?download`} download={result.name} aria-label={`Download ${result.name}`}>
        <DownloadIcon />
      </a>
    </div>
  );
}

// "crf 18, pass 1/2" is the encoder's wording, not something to show as it is.
const describeStage = (stage: string) =>
  stage.replace(/^crf \d+(?:, pass (\d)\/(\d))?$/, (_, pass?: string, passes?: string) =>
    pass ? `encoding, pass ${pass} of ${passes}` : 'encoding',
  );

function Status({ item, onRetry }: { item: Item; onRetry: () => void }) {
  if (item.status === 'error') {
    return (
      <div className="status status--error">
        <span>{item.error ?? 'Something went wrong.'}</span>
        <button className="btn btn--link" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  let text = '';
  let ratio: number | null = null;
  if (item.status === 'reading') text = 'Reading';
  else if (item.status === 'waiting') text = 'Waiting';
  else if (item.status === 'working') {
    if (item.progress) {
      text = `${FORMAT_NAMES[item.progress.format] ?? item.progress.format}: ${describeStage(item.progress.stage)}`;
      ratio = item.progress.ratio;
    } else text = item.kind === 'video' ? 'Starting' : 'Compressing and checking every pixel';
  }
  if (!text) return null;

  return (
    <div className={`status${ratio === null ? ' is-indeterminate' : ''}`}>
      <span className="status__track" aria-hidden="true">
        <span className="status__fill" style={ratio === null ? undefined : { transform: `scaleX(${ratio})` }} />
      </span>
      <span className="status__text">{ratio === null ? text : `${text}, ${Math.round(ratio * 100)}%`}</span>
    </div>
  );
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

  let note: React.ReactNode = null;
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
    <article className="file">
      <div className="thumb">
        {item.preview ? (
          // a local object URL: next/image has nothing to optimise here
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.preview} alt="" />
        ) : (
          <span className="thumb__ext">{dot === -1 ? '' : item.name.slice(dot + 1, dot + 5).toLowerCase()}</span>
        )}
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

        {note && <div className="file__note">{note}</div>}

        {open && choice && (
          <div className="panel">
            <Controls choice={choice} onChange={onChange} />
            {item.custom && (
              <button className="btn btn--link panel__reset" type="button" onClick={onReset}>
                Use shared settings
              </button>
            )}
          </div>
        )}

        <Status item={item} onRetry={onRetry} />

        {item.outcome && (
          // results from older settings stay visible, dimmed, until they are redone
          <div className={`results${stale || busy ? ' is-stale' : ''}`}>
            {item.outcome.results.map((result) => (
              <ResultLine key={result.name + result.format} item={item} outcome={item.outcome as Outcome} result={result} />
            ))}
            {item.outcome.warnings.map((warning) => (
              <p key={warning} className="warning">
                {capitalise(warning)}
              </p>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
