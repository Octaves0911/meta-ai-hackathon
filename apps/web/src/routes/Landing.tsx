import { Hero } from '../landing/Hero';
import { Nav } from '../landing/Nav';
import { Agents, Bento, FinalCta, Footer, Privacy, Statement } from '../landing/Sections';
import { Story } from '../landing/Story';
import '../styles/landing.css';

export function Landing() {
  return (
    <div className="lp2" id="top">
      <Nav />
      <Hero />
      <Statement />
      <Story />
      <Bento />
      <Agents />
      <Privacy />
      <FinalCta />
      <Footer />
    </div>
  );
}
