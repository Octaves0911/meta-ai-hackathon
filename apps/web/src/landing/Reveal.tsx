import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { useRef, type ReactNode } from 'react';

const EASE = [0.2, 0.7, 0.2, 1] as const;

/** Fade-and-rise when scrolled into view (instant for reduced motion). */
export function Reveal({ children, delay = 0, y = 28, className, as = 'div', now = false }: { children: ReactNode; delay?: number; y?: number; className?: string; as?: 'div' | 'section' | 'li'; now?: boolean }) {
  const reduced = useReducedMotion();
  const M = motion[as];
  return (
    <M className={className} initial={reduced ? false : { opacity: 0, y }} {...(now ? { animate: { opacity: 1, y: 0 } } : { whileInView: { opacity: 1, y: 0 } })} viewport={{ once: true, margin: '-12% 0px' }} transition={{ duration: 0.8, ease: EASE, delay }}>
      {children}
    </M>
  );
}

function Word({ word, p, range }: { word: string; p: MotionValue<number>; range: [number, number] }) {
  const opacity = useTransform(p, range, [0.14, 1]);
  const blur = useTransform(p, range, ['blur(4px)', 'blur(0px)']);
  return <motion.span style={{ opacity, filter: blur, display: 'inline-block', marginRight: '0.28em' }}>{word}</motion.span>;
}

/** Apple-style statement: each word brightens as the section scrolls through the viewport. */
export function WordReveal({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.85', 'end 0.45'] });
  const words = text.split(' ');
  if (reduced) return <h2 ref={ref} className={className}>{text}</h2>;
  return (
    <h2 ref={ref} className={className} aria-label={text}>
      <span aria-hidden>{words.map((w, i) => <Word key={i} word={w} p={scrollYProgress} range={[i / words.length, Math.min(1, (i + 1.6) / words.length)]} />)}</span>
    </h2>
  );
}
