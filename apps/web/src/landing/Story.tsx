import { motion, useMotionValueEvent, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { useRef, useState } from 'react';
import { useCinematic } from './hooks';
import { AnswerCard, CallArea, ConflictCard, Frame, TaskRow } from './Mocks';

const SCENES = [
  { k: 'Talk', title: 'Just have the meeting.', text: 'Join a call and captions start on their own, attributed to each speaker and saved as a searchable transcript.' },
  { k: 'Remember', title: 'It remembers for you.', text: 'Turn on AI Assistance and MeetPilot recalls past decisions, answers questions from memory and flags conflicts as they happen.' },
  { k: 'Execute', title: 'Then it gets to work.', text: 'End the meeting to get your task table. Specialist agents start drafting; you review and approve.' },
] as const;

const LINE = 'Let’s ship on September 5, and Priya will research competitor pricing by Friday.';

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));

/** One device whose content is a pure function of scroll progress p (0 to 1). */
function StoryDevice({ p }: { p: number }) {
  const typed = LINE.slice(0, Math.round(seg(p, 0.02, 0.3) * LINE.length));
  // the memory cards give way to the task list in scene three
  const out = 1 - seg(p, 0.64, 0.7);
  const conflict = seg(p, 0.38, 0.5) * out;
  const answer = seg(p, 0.5, 0.62) * out;
  const t = [seg(p, 0.7, 0.78), seg(p, 0.76, 0.84), seg(p, 0.82, 0.9)];
  const show = (v: number) => ({ opacity: v, transform: `translateY(${(1 - v) * 26}px) scale(${0.96 + v * 0.04})` });
  const work = p > 0.93 ? 'ready to review' : 'working';
  return (
    <Frame title="Sprint sync" className="story-frame">
      <div className="lframe-body">
        <CallArea caption={<>{typed}<span className="caret" /></>} />
        <div className="mock-feed">
          {conflict > 0 && <ConflictCard style={show(conflict)} />}
          {answer > 0 && <AnswerCard style={show(answer)} />}
          {t[0] > 0 && <TaskRow style={show(t[0])} title="Research competitor pricing" who="Priya" due="Friday" state={work} />}
          {t[1] > 0 && <TaskRow style={show(t[1])} title="Draft launch announcement" who="Aman" due="Sep 3" state={work} />}
          {t[2] > 0 && <TaskRow style={show(t[2])} title="Ship to production" who="Dana" due="Sep 5" state="queued" />}
        </div>
      </div>
    </Frame>
  );
}

function SceneCopy({ i, p }: { i: number; p: MotionValue<number> }) {
  const a = i / 3, b = (i + 1) / 3;
  // keyframes must stay inside [0, 1] and strictly increase; first scene starts visible, last stays visible
  const input = [i === 0 ? 0 : a - 0.04, i === 0 ? 0.001 : a + 0.05, b - 0.06, i === 2 ? 1 : b + 0.01];
  const opacity = useTransform(p, input, [i === 0 ? 1 : 0, 1, 1, i === 2 ? 1 : 0]);
  const y = useTransform(p, input, [i === 0 ? 0 : 36, 0, 0, i === 2 ? 0 : -36]);
  const s = SCENES[i];
  return (
    <motion.div className="scene-copy" style={{ opacity, y }}>
      <span className="step-no">0{i + 1} · {s.k}</span>
      <h2>{s.title}</h2>
      <p>{s.text}</p>
    </motion.div>
  );
}

export function Story() {
  const cinematic = useCinematic();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const [p, setP] = useState(0);
  useMotionValueEvent(scrollYProgress, 'change', (v) => setP(clamp(v)));
  const bar = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);

  if (!cinematic) {
    // No pinning on phones or for reduced motion: three stacked scenes, each showing its end state.
    const stops = [0.3, 0.62, 0.97];
    return (
      <section className="story-static" id="story">
        {SCENES.map((s, i) => (
          <div className="story-static-scene" key={s.k}>
            <div className="scene-copy static"><span className="step-no">0{i + 1} · {s.k}</span><h2>{s.title}</h2><p>{s.text}</p></div>
            <StoryDevice p={stops[i]} />
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className="story" id="story" ref={ref}>
      <div className="story-pin">
        <div className="story-copy">{SCENES.map((_, i) => <SceneCopy key={i} i={i} p={scrollYProgress} />)}</div>
        <div className="story-stage"><div className="story-halo" aria-hidden /><StoryDevice p={p} /></div>
        <div className="story-progress" aria-hidden><div className="story-progress-bar" style={{ width: 0 }}><motion.i style={{ width: bar }} /></div>{SCENES.map((s, i) => <span key={s.k} className={p >= i / 3 - 0.001 ? 'on' : ''}>{s.k}</span>)}</div>
      </div>
    </section>
  );
}
