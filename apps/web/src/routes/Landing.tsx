import { Link } from 'react-router-dom';
import { ArrowRight, Bot, CheckCircle2, FileSearch, Lock, Mic, ShieldCheck, Sparkles, Users, Zap, AlertTriangle, MessageSquareQuote } from 'lucide-react';
import { Logo, ThemeToggle } from '../ui';

const FEATURES = [
  { icon: Mic, tone: '', title: 'Live captions', text: 'Subtitles over the video, attributed to each speaker, saved as a searchable transcript.' },
  { icon: Sparkles, tone: 'ai', title: 'A quiet assistant', text: 'Spots decisions, conflicts and open questions while people talk, and speaks only when it matters.' },
  { icon: FileSearch, tone: '', title: 'Project memory', text: 'Earlier meetings, files, mail and Drive are searched by meaning and cited as sources.' },
  { icon: CheckCircle2, tone: 'ok', title: 'Tasks that write themselves', text: 'Owners, assigners and real due dates, ready as a table the moment the meeting ends.' },
  { icon: Bot, tone: 'ai', title: 'Agents that do the work', text: 'Research, marketing, design, writing and code specialists draft it; you review and approve.' },
  { icon: Lock, tone: 'warn', title: 'Private by default', text: 'Read-only integrations, per-source privacy, and nothing sent without your explicit click.' },
];

export function Landing() {
  return (
    <div className="lp">
      <nav className="lp-nav" aria-label="Main">
        <Link to="/" className="brand"><Logo /> <span>MeetPilot</span></Link>
        <div className="links"><a href="#features">Features</a><a href="#how">How it works</a><a href="#privacy">Privacy</a></div>
        <div className="cta"><ThemeToggle /><Link to="/start"><button className="primary">Get started</button></Link></div>
      </nav>

      <header className="lp-wrap hero">
        <span className="pill ai eyebrow"><Sparkles size={13} /> The AI copilot for your meetings</span>
        <h1>Don’t just talk. <em>Execute.</em></h1>
        <p className="lead">MeetPilot listens in real time, remembers every decision, and turns what was said into tasks that AI specialists start on, for you to review.</p>
        <div className="cta-row">
          <Link to="/start"><button className="primary btn-lg">Get started free <ArrowRight size={18} /></button></Link>
          <a href="#how"><button className="btn-lg">See how it works</button></a>
        </div>

        <div className="lp-shot" aria-hidden>
          <div className="bar-top"><i /><i /><i /><span className="faint" style={{ marginLeft: 10, fontSize: 12.5 }}>Sprint sync · 3 in call</span></div>
          <div className="body">
            <div className="video">
              <div className="tiles">
                <div className="t"><span>Priya</span></div><div className="t"><span>Aman</span></div>
              </div>
              <div className="sub"><b>Priya:</b> Let’s ship on September 5.</div>
            </div>
            <div className="feed">
              <div className="insight kind-conflict"><div className="insight-head"><span className="ico"><AlertTriangle size={14} /></span><strong>Conflicts with an earlier decision</strong></div><div className="insight-body">Release planning decided deployment on August 1.</div><div className="insight-source">Source: Meeting “Release planning” · Oct 30</div></div>
              <div className="insight kind-answer"><div className="insight-head"><span className="ico"><MessageSquareQuote size={14} /></span><strong>Answer</strong></div><div className="insight-body">We chose streaming captions for latency.</div></div>
              <div className="task-card"><strong>Research competitor pricing</strong><div className="row" style={{ marginTop: 8, gap: 8 }}><span className="pill accent">Priya</span><span className="pill">Due Friday</span><span className="pill ai"><Bot size={12} /> agent working</span></div></div>
            </div>
          </div>
        </div>
      </header>

      <main className="lp-wrap">
        <section className="lp-section" id="features">
          <div className="kicker">Everything in one room</div>
          <h2>From conversation to done, without the busywork</h2>
          <p className="sub">One calm assistant instead of ten notification-heavy tools.</p>
          <div className="feature-grid">
            {FEATURES.map(({ icon: Icon, tone, title, text }) => (
              <div className="feature" key={title}><div className={`ico ${tone}`}><Icon size={22} /></div><h3>{title}</h3><p>{text}</p></div>
            ))}
          </div>
        </section>

        <section className="lp-section" id="how">
          <div className="kicker">How it works</div>
          <h2>Three steps, no setup ritual</h2>
          <div className="steps" style={{ marginTop: 24 }}>
            <div className="step"><h3>Talk</h3><p>Join a call. Captions start on their own and every line is saved.</p></div>
            <div className="step"><h3>Remember</h3><p>Turn on AI Assistance: it recalls past decisions and flags conflicts as they happen.</p></div>
            <div className="step"><h3>Execute</h3><p>End the meeting to get your task table, then review the agents’ drafts and approve.</p></div>
          </div>
        </section>

        <section className="privacy-band" id="privacy">
          <div>
            <div className="kicker" style={{ color: 'var(--accent-text)', fontWeight: 650, fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>Trust by design</div>
            <h2 style={{ fontSize: 32, letterSpacing: '-0.03em' }}>Your data stays yours</h2>
            <p className="muted" style={{ fontSize: 16.5 }}>Only text is stored, never audio or video. You decide what the assistant can see.</p>
          </div>
          <ul>
            <li><ShieldCheck size={20} /> Read-only Gmail and Drive, nothing read until you choose</li>
            <li><Lock size={20} /> Private by default, shared only after you confirm</li>
            <li><Users size={20} /> Insights from your private mail go only to you</li>
            <li><Zap size={20} /> Emails send only after you review and click</li>
          </ul>
        </section>

        <section className="cta-band">
          <h2>Run your next meeting with a copilot</h2>
          <p>Create an account in seconds. No password, no credit card.</p>
          <Link to="/start"><button className="primary btn-lg">Get started <ArrowRight size={18} /></button></Link>
        </section>

        <footer className="lp-foot"><span>© MeetPilot</span><span>Built for the Meta AI hackathon</span></footer>
      </main>
    </div>
  );
}
