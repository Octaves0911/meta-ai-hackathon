import { ArrowRight, Sparkles } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'framer-motion';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useMagnetic } from './hooks';
import { AnswerCard, CallArea, ConflictCard, Frame, TaskRow } from './Mocks';

export function Hero() {
  const reduced = useReducedMotion();
  const magnet = useMagnetic<HTMLButtonElement>(0.3);
  const shot = useRef<HTMLDivElement>(null);
  const { scrollYProgress: pageY } = useScroll();
  const { scrollYProgress: p } = useScroll({ target: shot, offset: ['start end', 'end start'] });
  const sp = useSpring(p, { stiffness: 90, damping: 24, mass: 0.4 });

  // the product rises out of the page: tilts flat, scales up, then drifts away
  const rotateX = useTransform(sp, [0, 0.4, 1], [22, 0, -4]);
  const scale = useTransform(sp, [0, 0.4, 1], [0.86, 1, 0.97]);
  const y = useTransform(sp, [0, 1], [90, -60]);
  const glow = useTransform(sp, [0, 0.4, 1], [0.15, 0.7, 0.2]);
  // floating cards travel at different speeds: parallax depth
  const f1 = useTransform(sp, [0, 1], [120, -140]);
  const f2 = useTransform(sp, [0, 1], [180, -80]);
  const f3 = useTransform(sp, [0, 1], [60, -200]);
  // headline gently recedes as you scroll
  const heroY = useTransform(pageY, [0, 0.15], [0, -50]);
  const heroO = useTransform(pageY, [0, 0.14], [1, 0.25]);

  return (
    <header className="hero2">
      <div className="aurora" aria-hidden><i /><i /><i /></div>
      <motion.div className="hero2-copy" style={reduced ? undefined : { y: heroY, opacity: heroO }}>
        <motion.span className="pill ai eyebrow" initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.05 }}><Sparkles size={13} /> Your meetings, with a memory</motion.span>
        <h1 className="mega">
          {['Don’t just talk.', 'Execute.'].map((line, i) => (
            <motion.span key={line} className={`line${i ? ' grad' : ''}`} initial={reduced ? false : { opacity: 0, y: 46, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.95, delay: 0.15 + i * 0.16, ease: [0.2, 0.7, 0.2, 1] }}>{line}</motion.span>
          ))}
        </h1>
        <motion.p className="lead" initial={reduced ? false : { opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.5 }}>
          MeetPilot listens, remembers every decision, and turns what was said into work that AI specialists start on, for you to review.
        </motion.p>
        <motion.div className="cta-row" initial={reduced ? false : { opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.65 }}>
          <Link to="/start"><button className="primary btn-lg glow" {...magnet}>Get started free <ArrowRight size={18} /></button></Link>
          <a href="#story"><button className="btn-lg ghost-lg">Watch it work</button></a>
        </motion.div>
      </motion.div>

      <div className="hero2-stage" ref={shot} style={{ perspective: 1600 }}>
        <motion.div className="hero2-glow" style={reduced ? undefined : { opacity: glow }} aria-hidden />
        <motion.div style={reduced ? undefined : { rotateX, scale, y, transformOrigin: '50% 0%' }}>
          <Frame title="Sprint sync · 4 in call" className="hero-frame">
            <div className="lframe-body">
              <CallArea caption="Let’s ship on September 5." />
              <div className="mock-feed"><ConflictCard /><AnswerCard /><TaskRow title="Research competitor pricing" who="Priya" due="Friday" state="working" /></div>
            </div>
          </Frame>
        </motion.div>
        {!reduced && (
          <>
            <motion.div className="floaty f1" style={{ y: f1 }} aria-hidden><div className="floaty-card"><span className="ico"><Sparkles size={14} /></span><div><strong>Decision recorded</strong><span>Deploy · Sep 5</span></div></div></motion.div>
            <motion.div className="floaty f2" style={{ y: f2 }} aria-hidden><div className="floaty-card"><span className="avatar sm" style={{ background: 'var(--ai)' }}>AI</span><div><strong>Agent finished</strong><span>Research report ready</span></div></div></motion.div>
            <motion.div className="floaty f3" style={{ y: f3 }} aria-hidden><div className="floaty-card"><span className="ico ok">✓</span><div><strong>4 tasks</strong><span>assigned with due dates</span></div></div></motion.div>
          </>
        )}
      </div>
    </header>
  );
}
