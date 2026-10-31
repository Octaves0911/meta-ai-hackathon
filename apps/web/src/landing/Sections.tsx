import { ArrowRight, Bot, CheckCircle2, FileSearch, Lock, Megaphone, Mic, Palette, Search, ShieldCheck, Sparkles, Users, Zap, Code2, PenLine } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { spotlight, useCountUp, useMagnetic } from './hooks';
import { Reveal, WordReveal } from './Reveal';
import { Logo } from '../ui';

export function Statement() {
  return (
    <section className="statement">
      <WordReveal className="statement-text" text="Meetings end. Decisions get forgotten. Work stalls in someone’s notes. MeetPilot remembers everything, and turns talk into done." />
    </section>
  );
}

const TILES = [
  { cls: 'wide', icon: Mic, tone: '', title: 'Live captions', text: 'Subtitles over the video, one speaker per line, saved as a transcript you can search.', visual: 'captions' },
  { cls: '', icon: Sparkles, tone: 'ai', title: 'A quiet assistant', text: 'Speaks only when it matters. Governed, never noisy.', visual: 'quiet' },
  { cls: '', icon: FileSearch, tone: '', title: 'Project memory', text: 'Meetings, files, mail and Drive, searched by meaning and cited.', visual: 'memory' },
  { cls: 'wide', icon: CheckCircle2, tone: 'ok', title: 'Tasks that write themselves', text: 'Owners, assigners and real due dates, as a table the moment the call ends.', visual: 'tasks' },
] as const;

function TileVisual({ v }: { v: (typeof TILES)[number]['visual'] }) {
  if (v === 'captions') return <div className="tv tv-captions"><p><b>Priya</b> We should ship on the fifth.</p><p><b>Aman</b> Agreed, I’ll write the notes.</p><p className="live"><b>Dana</b> And I’ll book the deploy<span className="caret" /></p></div>;
  if (v === 'quiet') return <div className="tv tv-quiet"><i /><i /><i /><i /><b><Sparkles size={14} /></b></div>;
  if (v === 'memory') return <div className="tv tv-memory"><span><Search size={13} /> deployment date</span><em>Release planning · Oct 30</em><em>Architecture sync · Oct 12</em></div>;
  return <div className="tv tv-tasks"><span><i /> Research pricing <u>Fri</u></span><span><i /> Draft announcement <u>Sep 3</u></span><span><i /> Ship to production <u>Sep 5</u></span></div>;
}

export function Bento() {
  return (
    <section className="bento-sec" id="features">
      <Reveal className="sec-head"><span className="kicker">Everything in one room</span><h2>From conversation to done, <span className="grad">without the busywork.</span></h2></Reveal>
      <div className="bento">
        {TILES.map(({ cls, icon: Icon, tone, title, text, visual }, i) => (
          <Reveal key={title} delay={(i % 2) * 0.08} className={`tile-wrap ${cls}`}>
            <div className="tile" onPointerMove={spotlight}>
              <div className={`ico ${tone}`}><Icon size={20} /></div>
              <h3>{title}</h3><p>{text}</p>
              <TileVisual v={visual} />
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

const AGENTS = [
  { icon: Search, name: 'Research' }, { icon: Megaphone, name: 'Marketing' }, { icon: Palette, name: 'Design' },
  { icon: PenLine, name: 'Communication' }, { icon: Code2, name: 'Code' }, { icon: Bot, name: 'Router' },
];

export function Agents() {
  const reduced = useReducedMotion();
  const row = [...AGENTS, ...AGENTS, ...AGENTS];
  return (
    <section className="agents-sec" id="agents">
      <Reveal className="sec-head"><span className="kicker">Specialists on call</span><h2>Agents draft. <span className="grad">You decide.</span></h2><p>Every draft waits for your review, with up to three revision rounds. Nothing is sent until you click.</p></Reveal>
      <div className="marquee" aria-hidden>
        <div className={`marquee-track${reduced ? ' still' : ''}`}>
          {row.map(({ icon: Icon, name }, i) => <div className="agent-chip" key={i}><span className="ico ai"><Icon size={18} /></span>{name}</div>)}
        </div>
      </div>
      <ul className="sr-only">{AGENTS.map((a) => <li key={a.name}>{a.name} agent</li>)}</ul>
    </section>
  );
}

function Stat({ to, suffix, label }: { to: number; suffix?: string; label: string }) {
  const { ref, value } = useCountUp(to);
  return <div className="stat-big"><strong><span ref={ref as never}>{value}</span>{suffix}</strong><span>{label}</span></div>;
}

export function Privacy() {
  return (
    <section className="privacy2" id="privacy" data-theme="dark">
      <div className="privacy2-inner">
        <Reveal className="sec-head left"><span className="kicker">Trust by design</span><h2>Your data stays <span className="grad">yours.</span></h2><p>Only text is stored, never audio or video. You decide what the assistant can see.</p></Reveal>
        <div className="stats">
          <Stat to={0} label="seconds of audio or video stored" />
          <Stat to={100} suffix="%" label="of emails sent only after your click" />
          <Stat to={3} label="review rounds per agent draft" />
        </div>
        <ul className="trust-list">
          <Reveal as="li"><ShieldCheck size={20} /> Read-only Gmail and Drive, nothing read until you choose</Reveal>
          <Reveal as="li" delay={0.06}><Lock size={20} /> Private by default, shared only after you confirm</Reveal>
          <Reveal as="li" delay={0.12}><Users size={20} /> Insights from your private mail go only to you</Reveal>
          <Reveal as="li" delay={0.18}><Zap size={20} /> Sending needs a separate permission and a confirmation</Reveal>
        </ul>
      </div>
    </section>
  );
}

export function FinalCta() {
  const magnet = useMagnetic<HTMLButtonElement>(0.3);
  return (
    <section className="final">
      <div className="aurora soft" aria-hidden><i /><i /><i /></div>
      <Reveal><h2 className="mega sm">Run your next meeting<br /><span className="grad">with a copilot.</span></h2></Reveal>
      <Reveal delay={0.1}><p className="lead">Create an account in seconds. No password, no credit card.</p></Reveal>
      <Reveal delay={0.18}><Link to="/start"><button className="primary btn-lg glow" {...magnet}>Get started free <ArrowRight size={18} /></button></Link></Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="foot2">
      <div className="foot2-inner">
        <span className="brand"><Logo size={22} /> MeetPilot</span>
        <span className="faint">Built for the Meta AI hackathon</span>
        <motion.a whileHover={{ y: -2 }} href="#top" className="faint">Back to top ↑</motion.a>
      </div>
    </footer>
  );
}
