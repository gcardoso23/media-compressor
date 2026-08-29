'use client';

import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { kindOf } from '@/engine/media.ts';
import type { Flags, Tools } from '@/engine/server/protocol.ts';
import type { MediaKind } from '@/engine/types.ts';
import { limiter } from '@/engine/utils/pool.ts';
import { compressFile, describeError, forgetFile, getTools, uploadFile } from '@/lib/api.ts';
import { type Choice, type Choices, DEFAULTS, loadChoices, saveChoices, toFlags } from '@/lib/choices.ts';
import { costOf, learnSpeed, measureRun, noWork, predict, remaining, speed, type RunState } from '@/lib/estimate.ts';
import { type Item, filesFrom, videoFrame } from '@/lib/files.ts';
import { plural } from '@/lib/format.ts';
import { slow, smooth } from '@/lib/motion.ts';
import { Controls } from './controls.tsx';
import { Dock } from './dock.tsx';
import { FileRow } from './file-row.tsx';

// Files go to the local server, and through the encoders, a few at a time.
const uploads = limiter(3);
const runs = limiter(3);

const KINDS: MediaKind[] = ['image', 'video'];

interface Batch {
  // the work each file in the run represents
  costs: Record<string, number>;
  started: number;
  // the learned speed when it started
  rate: number;
  stopped: boolean;
}

// Seconds left in the run, recomputed twice a second and eased toward each new
// figure, so it counts down steadily instead of jumping around.
function useEta(batch: Batch | null, run: RunState | null, busy: boolean): number | null {
  const [eta, setEta] = useState<number | null>(null);
  const latest = useRef({ batch, run });
  latest.current = { batch, run };

  useEffect(() => {
    if (!busy) {
      setEta(null);
      return;
    }
    const tick = () => {
      const { batch: current, run: state } = latest.current;
      if (!current || !state) return;
      const elapsed = (performance.now() - current.started) / 1000;
      const target = remaining({ done: state.done, left: state.left, elapsed, rate: current.rate });
      setEta((shown) => (shown === null ? target : Math.max(0, shown - 0.5 + (target - (shown - 0.5)) * 0.2)));
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [busy]);

  return eta;
}

// Files with settings to choose: everything but SVGs and files the tool can't read.
const configurable = (item: Item): item is Item & { kind: MediaKind } => item.kind !== null && !item.vector;

function flagsFor(item: Item, shared: Choices): Flags {
  // an SVG only follows the shared quality setting: exact or not
  if (item.vector) return toFlags(shared.image);
  if (!configurable(item)) return {};
  return toFlags(item.custom ?? shared[item.kind]);
}

const isStale = (item: Item, shared: Choices) => item.status === 'done' && item.ran !== JSON.stringify(flagsFor(item, shared));

const isPending = (item: Item, shared: Choices) =>
  item.kind !== null && (item.status === 'ready' || isStale(item, shared) || item.status === 'error');

export function Workbench() {
  const [items, setItems] = useState<Item[]>([]);
  const [shared, setShared] = useState<Choices>(DEFAULTS);
  // the file whose own settings are open
  const [open, setOpen] = useState<string | null>(null);
  // the latest "Compress" press: which files, how much work each, and when it began
  const [batch, setBatch] = useState<Batch | null>(null);
  const [tools, setTools] = useState<Tools | null>(null);
  const [dragging, setDragging] = useState(false);

  const picker = useRef<HTMLInputElement>(null);
  // per file: the upload in flight (resolving to the server's id), and the run that can be cancelled
  const uploaded = useRef(new Map<string, Promise<string | undefined>>());
  const controllers = useRef(new Map<string, AbortController>());

  // Saved settings are read once. Development reloads re-run effects, and must
  // not put back old settings over ones just changed.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setShared(loadChoices());
    getTools()
      .then(setTools)
      .catch(() => {});
  }, []);

  const patch = useCallback((key: string, update: Partial<Item> | ((item: Item) => Partial<Item>)) => {
    setItems((list) =>
      list.map((item) => (item.key === key ? { ...item, ...(typeof update === 'function' ? update(item) : update) } : item)),
    );
  }, []);

  const upload = useCallback(
    (item: Item) => {
      const pending = uploads(async () => {
        try {
          const { id, media } = await uploadFile(item.file);
          patch(item.key, (current) => ({ id, media, status: current.status === 'reading' ? 'ready' : current.status }));
          return id;
        } catch (error) {
          patch(item.key, { status: 'error', error: describeError(error) });
          return undefined;
        }
      });
      uploaded.current.set(item.key, pending);
      return pending;
    },
    [patch],
  );

  const add = useCallback(
    (files: File[]) => {
      const fresh = files.map((file): Item => {
        const kind = kindOf(file.name);
        return {
          key: crypto.randomUUID(),
          file,
          name: file.name,
          bytes: file.size,
          kind,
          vector: /\.svg$/i.test(file.name),
          status: kind ? 'reading' : 'unsupported',
          error: kind ? undefined : `${file.name} isn't an image or video this tool can read.`,
          preview: kind === 'image' ? URL.createObjectURL(file) : undefined,
        };
      });
      setItems((list) => [...list, ...fresh]);
      for (const item of fresh) {
        if (!item.kind) continue;
        void upload(item);
        if (item.kind === 'video') {
          void videoFrame(item.file).then((url) => {
            if (url) patch(item.key, { preview: url });
          });
        }
      }
    },
    [patch, upload],
  );

  const run = useCallback(
    async (item: Item, flags: Flags) => {
      controllers.current.get(item.key)?.abort();
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      patch(item.key, { status: 'waiting', progress: undefined, fraction: 0, scale: 1, error: undefined });

      await runs(async () => {
        if (controller.signal.aborted) return;
        // a file that failed to upload gets another go
        const id = (await uploaded.current.get(item.key)) ?? (await upload(item));
        if (controller.signal.aborted) return;
        if (!id) {
          patch(item.key, (current) => ({ status: 'error', error: current.error ?? 'This file could not be read.' }));
          return;
        }

        patch(item.key, { status: 'working' });
        try {
          let finished = false;
          for await (const event of compressFile(id, flags, controller.signal)) {
            if (event.type === 'progress') {
              // a quality retry adds work, so the share done can dip: the bar never goes back
              const overall = Number.isFinite(event.overall) ? event.overall : 0;
              const scale = Number.isFinite(event.scale) ? event.scale : 1;
              patch(item.key, (current) => ({
                progress: { ...event, overall, scale },
                fraction: Math.max(current.fraction ?? 0, overall),
                scale,
              }));
            }
            else if (event.type === 'error') throw new Error(event.message);
            else if (event.type === 'done') {
              finished = true;
              patch(item.key, {
                status: 'done',
                progress: undefined,
                fraction: 1,
                ran: JSON.stringify(flags),
                outcome: { sourceBytes: event.sourceBytes, results: event.results, warnings: event.warnings },
              });
            }
          }
          if (!finished) throw new Error('The local server stopped before this file was finished.');
        } catch (error) {
          if (controller.signal.aborted) return;
          patch(item.key, { status: 'error', error: describeError(error) });
        }
      });
    },
    [patch, upload],
  );

  const start = (targets: Item[]) => {
    if (!targets.length) return;
    const costs = Object.fromEntries(targets.map((item) => [item.key, costOf(item, shared) || 0]));
    setBatch({ costs, started: performance.now(), rate: speed(), stopped: false });
    setOpen(null);
    for (const item of targets) void run(item, flagsFor(item, shared));
  };

  const compressAll = () => start(items.filter((item) => isPending(item, shared)));

  // Cancels what is queued or running; files keep whatever results they had.
  const stop = () => {
    setBatch((current) => current && { ...current, stopped: true });
    for (const item of items) {
      if (item.status !== 'waiting' && item.status !== 'working') continue;
      controllers.current.get(item.key)?.abort();
      patch(item.key, (current) => ({ status: current.outcome ? 'done' : 'ready', progress: undefined, fraction: 0 }));
    }
  };

  const forget = (item: Item) => {
    controllers.current.get(item.key)?.abort();
    controllers.current.delete(item.key);
    void uploaded.current.get(item.key)?.then((id) => id && forgetFile(id));
    uploaded.current.delete(item.key);
    if (item.preview?.startsWith('blob:')) URL.revokeObjectURL(item.preview);
  };

  const remove = (item: Item) => {
    forget(item);
    if (open === item.key) setOpen(null);
    setItems((list) => list.filter((other) => other.key !== item.key));
  };

  const clear = () => {
    items.forEach(forget);
    setOpen(null);
    setItems([]);
  };

  const changeShared = (kind: MediaKind, choice: Choice) => {
    setShared((current) => {
      const next = { ...current, [kind]: choice };
      saveChoices(next);
      return next;
    });
  };

  const choose = () => picker.current?.click();

  // Files can be dropped anywhere on the page, folders included, or pasted.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (depth++ === 0) setDragging(true);
    };
    const leave = () => {
      if (depth > 0 && --depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => event.preventDefault();
    const drop = async (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (event.dataTransfer) add(await filesFrom(event.dataTransfer));
    };
    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length) add(files);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
      window.removeEventListener('keydown', escape);
    };
  }, [add]);

  const count = (kind: MediaKind) => items.filter((item) => configurable(item) && item.kind === kind).length;
  const pending = items.filter((item) => isPending(item, shared)).length;
  const busy = items.filter((item) => item.status === 'waiting' || item.status === 'working').length;

  // One bar for the whole run: each file counts for the work it is, not just as one of n.
  const runState = batch ? measureRun(items, batch.costs) : null;
  const eta = useEta(batch, runState, busy > 0);

  const pendingWork = noWork();
  for (const item of items) if (item.kind && isPending(item, shared)) pendingWork[item.kind] += costOf(item, shared);

  // once a run finishes, how long it really took teaches the next estimate
  const wasBusy = useRef(false);
  const worked = runState?.done ?? 0;
  useEffect(() => {
    if (busy > 0) wasBusy.current = true;
    else if (wasBusy.current && batch) {
      wasBusy.current = false;
      if (!batch.stopped) learnSpeed((performance.now() - batch.started) / 1000, worked);
    }
  }, [busy, batch, worked]);

  const missing: string[] = [];
  if (tools && !tools.ffmpeg) missing.push('Videos need ffmpeg: brew install ffmpeg.');
  else if (tools && !tools.vmaf) missing.push("This ffmpeg has no libvmaf, so video quality won't be measured.");
  if (tools && !tools.jpegtran) missing.push('JPEGs pass through untouched until jpegtran is installed: brew install jpeg-turbo.');

  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };

  return (
    <MotionConfig reducedMotion="user" transition={smooth}>
      <header className="bar">
        <AnimatePresence>
          {items.length > 0 && (
            <motion.div key="actions" className="bar__actions" {...fade}>
              <button className="btn btn--text" type="button" onClick={clear}>
                Clear all
              </button>
              <button className="btn btn--ghost" type="button" onClick={choose}>
                Add files
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main>
        <AnimatePresence mode="wait">
          {items.length === 0 ? (
            <motion.section
              key="hero"
              className="hero"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.98, filter: 'blur(6px)', transition: { duration: 0.35 } }}
            >
              <button className="hero__drop" type="button" onClick={choose}>
                <span className="hero__title">
                  <motion.span initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ ...slow, delay: 0.1 }}>
                    Drop images or videos
                  </motion.span>
                </span>
                <motion.span
                  className="hero__hint"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...slow, delay: 0.25 }}
                >
                  or click to choose. Everything stays on this computer.
                </motion.span>
              </button>
            </motion.section>
          ) : (
            <motion.div
              key="workspace"
              className="workspace"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.3 } }}
            >
              <div className="settings">
                <AnimatePresence initial={false}>
                  {KINDS.filter((kind) => count(kind) > 0).map((kind) => (
                    <motion.section
                      key={kind}
                      className="group"
                      initial={{ opacity: 0, y: 14 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25 } }}
                    >
                      <header className="group__head">
                        <h2 className="group__title">{plural(count(kind), kind)}</h2>
                        <p className="group__sub">
                          {count(kind) > 1 ? `These apply to every ${kind} unless you customise one.` : `Settings for this ${kind}.`}
                        </p>
                      </header>
                      <Controls choice={shared[kind]} onChange={(choice) => changeShared(kind, choice)} />
                    </motion.section>
                  ))}
                </AnimatePresence>
              </div>

              <div className="files" aria-live="polite">
                <AnimatePresence initial={false}>
                  {items.map((item) => (
                    <FileRow
                      key={item.key}
                      item={item}
                      choice={configurable(item) ? (item.custom ?? shared[item.kind]) : null}
                      canCustomise={configurable(item) && count(item.kind) > 1}
                      open={open === item.key}
                      stale={isStale(item, shared)}
                      onToggle={() => setOpen(open === item.key ? null : item.key)}
                      onChange={(choice) => patch(item.key, { custom: choice })}
                      onReset={() => {
                        patch(item.key, { custom: undefined });
                        if (open === item.key) setOpen(null);
                      }}
                      onRemove={() => remove(item)}
                      onRetry={() => start([item])}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {items.length > 0 && (
          <Dock
            key="dock"
            items={items}
            pending={pending}
            busy={busy}
            files={runState?.files ?? 0}
            finished={runState?.finished ?? 0}
            progress={runState?.progress ?? 0}
            eta={eta}
            predicted={predict(pendingWork)}
            onCompress={compressAll}
            onStop={stop}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dragging && (
          <motion.div key="veil" className="veil" aria-hidden="true" {...fade} transition={{ duration: 0.25 }}>
            <motion.span initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={smooth}>
              Release to add
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {missing.length > 0 && items.length === 0 && (
          <motion.p key="notice" className="notice" role="status" {...fade}>
            {missing.join(' ')}
          </motion.p>
        )}
      </AnimatePresence>

      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
    </MotionConfig>
  );
}
