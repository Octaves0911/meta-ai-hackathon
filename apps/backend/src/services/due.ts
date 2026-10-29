// Resolve spoken deadlines to calendar dates (F7.2). Pure and UTC-based so it is deterministic and testable.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;

/** Today's date (YYYY-MM-DD) in MEETING_TZ, defaulting to the server's time zone — "Friday" means the user's Friday, not UTC's. */
export function todayInTz(now = new Date(), tz = process.env.MEETING_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
const daysInMonth = (y: number, m: number) => utc(y, m + 1, 0).getUTCDate();

/**
 * `today` is "YYYY-MM-DD". Supported: today, tomorrow, in N days/weeks, next week (Monday), next month (same day),
 * end of week (Friday), end of month, weekday names (the next occurrence after today), and "October 31" style dates
 * (this year, or next year if that date has already passed). Returns null when nothing recognisable is found.
 */
export function resolveDue(text: string | null | undefined, today: string): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate(), dow = base.getUTCDay();

  const monthDay = MONTH_RE.exec(text);
  if (monthDay) {
    const mi = MONTHS.indexOf(monthDay[1].slice(0, 3).toLowerCase());
    const day = Number(monthDay[2]);
    if (day >= 1 && day <= daysInMonth(y, mi)) {
      let cand = utc(y, mi, day);
      if (cand < base) cand = utc(y + 1, mi, Math.min(day, daysInMonth(y + 1, mi)));
      return iso(cand);
    }
  }
  const inN = /\bin (\d+) (day|week)s?\b/.exec(t);
  if (inN) return iso(addDays(base, Number(inN[1]) * (inN[2] === 'week' ? 7 : 1)));
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return iso(addDays(base, 1));
  if (/\bnext week\b/.test(t)) return iso(addDays(base, ((8 - dow) % 7) || 7)); // upcoming Monday
  if (/\bnext month\b/.test(t)) return iso(utc(y, m + 1, Math.min(d, daysInMonth(y, m + 1))));
  if (/\bend of (?:the )?week\b/.test(t)) return iso(addDays(base, (5 - dow + 7) % 7));
  if (/\bend of (?:the )?month\b/.test(t)) return iso(utc(y, m, daysInMonth(y, m)));
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${DAYS[i]}\\b`).test(t)) return iso(addDays(base, ((i - dow + 7) % 7) || 7));
  }
  return null;
}

/** "I will send the report by Friday." -> "Send the report". Leaves already-clean imperative titles untouched. */
export function taskTitle(summary: string): string {
  let s = summary.trim()
    .replace(/^(?:ok(?:ay)?,?\s*|so,?\s*|and\s+)/i, '')
    .replace(/^(?:i(?:'ll| will)|[A-Z][a-z]+ will|(?:can|could) you|please)\s+/i, '')
    .replace(/\s+(?:by|before|on|until)\s+(?:end of (?:the )?(?:week|month)|next (?:week|month)|today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?).*$/i, '')
    .replace(/[.?!\s]+$/, '')
    .replace(/\s+(?:today|tomorrow|next (?:week|month)|this (?:week|month)|end of (?:the )?(?:week|month))$/i, ''); // bare trailing deadline
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 100 ? `${s.slice(0, 99)}…` : s || summary.slice(0, 100);
}
