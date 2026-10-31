import { motion, useScroll, useSpring } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Logo, ThemeToggle } from '../ui';

export function Nav() {
  const [stuck, setStuck] = useState(false);
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 28 });
  useEffect(() => {
    const on = () => setStuck(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <nav className={`nav2${stuck ? ' stuck' : ''}`} aria-label="Main">
      <Link to="/" className="brand"><Logo size={26} /> <span>MeetPilot</span></Link>
      <div className="links"><a href="#story">How it works</a><a href="#features">Features</a><a href="#agents">Agents</a><a href="#privacy">Privacy</a></div>
      <div className="cta"><ThemeToggle /><Link to="/start"><button className="primary">Get started</button></Link></div>
      <motion.i className="nav2-progress" style={{ scaleX }} aria-hidden />
    </nav>
  );
}
