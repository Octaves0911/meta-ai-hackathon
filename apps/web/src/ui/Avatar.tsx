const COLORS = ['#0866ff', '#6d28d9', '#0f9d58', '#c2410c', '#be123c', '#0369a1', '#a21caf', '#4d7c0f'];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`avatar ${size === 'md' ? '' : size}`} style={{ background: COLORS[hash(name.toLowerCase()) % COLORS.length] }} aria-hidden>{name.slice(0, 2)}</span>;
}
