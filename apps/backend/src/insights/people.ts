// Map a spoken name ("Priya", "Sam,", "Dana's") to a project member. Speech-to-text mishears names, so exact username
// matching alone leaves most tasks unassigned.
export interface Person { id: string; username: string }

const clean = (s: string) => s.toLowerCase().replace(/['’]s$/, '').replace(/[^a-z0-9 ._-]/g, '').trim();
const PRONOUN = /^(i|me|myself|i'll|ill)$/i;
/** "I will…": the owner is whoever is speaking. A missing owner is NOT self; the task stays unassigned. */
export const isSelf = (who: string | null | undefined) => !!who && PRONOUN.test(who.trim());

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** The member the speaker meant, or null when nobody matches or the name is ambiguous. */
export function matchPerson(spoken: string | null | undefined, people: Person[]): Person | null {
  const name = clean(spoken ?? '');
  if (name.length < 2 || !people.length) return null;
  const unique = (xs: Person[]) => (xs.length === 1 ? xs[0] : null);
  const first = (u: string) => u.toLowerCase().split(/[._\-\s]/)[0];

  const exact = people.filter((p) => p.username.toLowerCase() === name);
  if (exact.length) return exact[0];
  const byFirst = unique(people.filter((p) => first(p.username) === name));
  if (byFirst) return byFirst;
  if (name.length >= 3) {
    const prefix = unique(people.filter((p) => p.username.toLowerCase().startsWith(name) || (first(p.username).length >= 3 && name.startsWith(first(p.username)))));
    if (prefix) return prefix;
  }
  if (name.length >= 4) { // "Pria" for "priya"
    const limit = name.length >= 7 ? 2 : 1;
    const close = people.map((p) => ({ p, d: Math.min(distance(name, p.username.toLowerCase()), distance(name, first(p.username))) })).filter((x) => x.d <= limit).sort((a, b) => a.d - b.d);
    if (close.length && (close.length === 1 || close[0].d < close[1].d)) return close[0].p;
  }
  return null;
}

/** "priya's" / "Priya," -> "Priya" for display when the person is not a member. */
export function spokenName(who: string): string {
  const w = who.trim().replace(/['’]s$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
}
