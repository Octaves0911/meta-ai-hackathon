import { animate, useInView, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

/** True while the media query matches (SSR-safe default false). */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Scroll-driven pinning is disabled on small screens and for people who prefer reduced motion. */
export function useCinematic(): boolean {
  const reduced = useReducedMotion();
  const narrow = useMediaQuery('(max-width: 900px)');
  return !reduced && !narrow;
}

/** Counts from 0 to `to` once the element scrolls into view. */
export function useCountUp(to: number, duration = 1.6) {
  const ref = useRef<HTMLElement | null>(null);
  const inView = useInView(ref, { once: true, margin: '-10% 0px' });
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? to : 0);
  useEffect(() => {
    if (!inView || reduced) return;
    const c = animate(0, to, { duration, ease: [0.2, 0.7, 0.2, 1], onUpdate: (v) => setValue(Math.round(v)) });
    return () => c.stop();
  }, [inView, to, duration, reduced]);
  return { ref, value };
}

/** Pointer-follow spotlight: sets --mx/--my (percent) on the card for a CSS radial-gradient glow. */
export function spotlight(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
  e.currentTarget.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
}

/** Magnetic hover: the element leans a few pixels toward the cursor. */
export function useMagnetic<T extends HTMLElement>(strength = 0.25) {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();
  const onMove = (e: PointerEvent<T>) => {
    if (reduced || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) * strength;
    const y = (e.clientY - (r.top + r.height / 2)) * strength;
    ref.current.style.transform = `translate(${x}px, ${y}px)`;
  };
  const onLeave = () => { if (ref.current) ref.current.style.transform = ''; };
  return { ref, onPointerMove: onMove, onPointerLeave: onLeave };
}
