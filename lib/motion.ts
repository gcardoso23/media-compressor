import type { Transition, Variants } from 'motion/react';

// One easing for everything: fast out, long gentle settle.
export const EASE = [0.22, 1, 0.36, 1] as const;

export const smooth: Transition = { duration: 0.55, ease: EASE };
export const slow: Transition = { duration: 1.1, ease: EASE };
// for things that follow the pointer, like the selected pill
export const spring: Transition = { type: 'spring', stiffness: 460, damping: 40, mass: 0.9 };

// Opens and closes to its natural height.
export const unfold: Variants = {
  hidden: { height: 0, opacity: 0 },
  shown: { height: 'auto', opacity: 1, transition: { height: smooth, opacity: { duration: 0.4, delay: 0.08 } } },
  gone: { height: 0, opacity: 0, transition: { height: smooth, opacity: { duration: 0.2 } } },
};

// Arrives with a short rise; leaves by fading.
export const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  shown: { opacity: 1, y: 0, transition: smooth },
  gone: { opacity: 0, transition: { duration: 0.25 } },
};
