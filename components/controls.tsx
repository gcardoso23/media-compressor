'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import { type Choice, type ImageChoice, RESIZE_MODES, type ResizeMode, type VideoChoice } from '@/lib/choices.ts';

const HINTS = {
  exact: 'Every pixel stays identical, and each file is checked against its original before you get it.',
  lossy: 'Much smaller and looks the same, the way TinyPNG works, but the pixels are no longer identical.',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="field__control">{children}</div>
    </div>
  );
}

// Several options can be on at once, and at least one always is.
function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T[];
  onChange: (next: T[]) => void;
}) {
  const toggle = (option: T) => {
    const on = value.includes(option);
    if (on && value.length === 1) return;
    const next = on ? value.filter((item) => item !== option) : [...value, option];
    // keep the options' own order, so "original" always comes first
    onChange(options.map(([item]) => item).filter((item) => next.includes(item)));
  };
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map(([option, text]) => {
        const on = value.includes(option);
        return (
          <button
            key={option}
            type="button"
            className="chip"
            aria-pressed={on}
            title={on && value.length === 1 ? 'At least one has to stay on' : undefined}
            onClick={() => toggle(option)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

// One option out of a few.
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (next: T) => void;
}) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <label key={option} className="segmented__option">
          <input type="radio" name={name} value={option} checked={option === value} onChange={() => onChange(option)} />
          <span>{text}</span>
        </label>
      ))}
    </div>
  );
}

function SizeControl({
  resize,
  amount,
  onChange,
}: {
  resize: ResizeMode;
  amount: number;
  onChange: (next: { resize: ResizeMode; amount: number }) => void;
}) {
  // typed freely, applied on blur or Enter
  const [draft, setDraft] = useState(String(amount));
  useEffect(() => setDraft(String(amount)), [amount]);

  const scale = resize === 'scale';
  const commit = () => {
    const max = scale ? 100 : 20000;
    const value = Math.min(max, Math.max(1, Math.round(Number(draft) || 1)));
    setDraft(String(value));
    if (value !== amount) onChange({ resize, amount: value });
  };

  const pick = (next: ResizeMode) => {
    // percentages and pixels live on different scales: start from a sensible value
    let value = amount;
    if (next === 'scale' && (value > 100 || value < 1)) value = 50;
    if (next !== 'scale' && next !== 'none' && value <= 100) value = 1920;
    onChange({ resize: next, amount: value });
  };

  return (
    <div className="size">
      <select className="select" aria-label="Size" value={resize} onChange={(event) => pick(event.target.value as ResizeMode)}>
        {RESIZE_MODES.map(([mode, text]) => (
          <option key={mode} value={mode}>
            {text}
          </option>
        ))}
      </select>
      {resize !== 'none' && (
        <label className="amount-wrap">
          <input
            className="amount"
            type="number"
            inputMode="numeric"
            min={1}
            max={scale ? 100 : undefined}
            aria-label="Amount"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
          />
          <span>{scale ? '%' : 'px'}</span>
        </label>
      )}
    </div>
  );
}

function ImageControls({ choice, onChange }: { choice: ImageChoice; onChange: (next: ImageChoice) => void }) {
  const set = (patch: Partial<ImageChoice>) => onChange({ ...choice, ...patch });
  return (
    <div className="fields">
      <Field label="Format">
        <Chips
          label="Format"
          options={[
            ['original', 'Original format'],
            ['webp', 'WebP'],
            ['avif', 'AVIF'],
          ]}
          value={choice.formats}
          onChange={(formats) => set({ formats })}
        />
      </Field>
      <Field label="Quality">
        <Segmented
          label="Quality"
          options={[
            ['exact', 'Exact pixels'],
            ['lossy', 'Visually lossless'],
          ]}
          value={choice.quality}
          onChange={(quality) => set({ quality })}
        />
        <p className="field__hint">{HINTS[choice.quality]}</p>
      </Field>
      <Field label="Size">
        <SizeControl resize={choice.resize} amount={choice.amount} onChange={set} />
      </Field>
    </div>
  );
}

function VideoControls({ choice, onChange }: { choice: VideoChoice; onChange: (next: VideoChoice) => void }) {
  const set = (patch: Partial<VideoChoice>) => onChange({ ...choice, ...patch });
  return (
    <div className="fields">
      <Field label="Format">
        <Chips
          label="Format"
          options={[
            ['mp4', 'MP4'],
            ['webm', 'WebM'],
          ]}
          value={choice.formats}
          onChange={(formats) => set({ formats })}
        />
      </Field>
      <Field label="Sound">
        <Segmented
          label="Sound"
          options={[
            ['keep', 'Keep'],
            ['remove', 'Remove'],
          ]}
          value={choice.sound}
          onChange={(sound) => set({ sound })}
        />
      </Field>
      <Field label="Size">
        <SizeControl resize={choice.resize} amount={choice.amount} onChange={set} />
      </Field>
    </div>
  );
}

// The settings for one kind of media.
export function Controls({ choice, onChange }: { choice: Choice; onChange: (next: Choice) => void }) {
  return choice.kind === 'image' ? (
    <ImageControls choice={choice} onChange={onChange} />
  ) : (
    <VideoControls choice={choice} onChange={onChange} />
  );
}
