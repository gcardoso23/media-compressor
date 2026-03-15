'use client';

import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { EASE } from '@/lib/motion.ts';

// A number that glides from its previous value to the new one.
export function AnimatedNumber({
  value,
  format,
  className,
  from = 0,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
  // where the first animation starts
  from?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(from);
  // kept in a ref so a new function on every render doesn't restart the animation
  const formatter = useRef(format);
  formatter.current = format;
  const reduced = useReducedMotion();

  useEffect(() => {
    const start = shown.current;
    const controls = animate(start, value, {
      duration: reduced ? 0 : 1.1,
      ease: EASE,
      onUpdate: (latest) => {
        shown.current = latest;
        if (ref.current) ref.current.textContent = formatter.current(latest);
      },
    });
    return () => controls.stop();
  }, [value, reduced]);

  return (
    <span ref={ref} className={className}>
      {format(shown.current)}
    </span>
  );
}
