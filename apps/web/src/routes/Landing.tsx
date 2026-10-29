import { Link } from 'react-router-dom';

const steps = [
  ['Talk', 'Live captions over video, attributed to each speaker.'],
  ['Remember', 'Decisions and files from earlier meetings surface at the moment they matter.'],
  ['Execute', 'Tasks are created with owners and due dates, and AI specialists draft the work for review.'],
];

export function Landing() {
  return (
    <div className="landing">
      <header className="hero">
        <h1>Don't just talk. Execute.</h1>
        <p>MeetPilot is a video meeting tool with a real-time AI assistant that remembers your projects.</p>
        <Link to="/start"><button className="primary">Get Started</button></Link>
      </header>
      <section aria-label="How it works" className="steps">
        {steps.map(([t, d], i) => (
          <div className="card" key={t}><h3>{i + 1}. {t}</h3><p className="muted">{d}</p></div>
        ))}
      </section>
      <section className="card">
        <h3>Private by design</h3>
        <p className="muted">Only text is stored — never audio or video. Connected mail and files are private by default.</p>
      </section>
    </div>
  );
}
