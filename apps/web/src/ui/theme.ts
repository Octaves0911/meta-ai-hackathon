import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
const KEY = 'meetpilot.theme';

const read = (): ThemeMode => {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
};
const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
const apply = (mode: ThemeMode) => document.documentElement.setAttribute('data-theme', mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode);

/** Light / dark / follow-system, persisted. The inline script in index.html applies it before first paint. */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(read);
  useEffect(() => {
    apply(mode);
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => apply('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mode]);
  const setMode = useCallback((m: ThemeMode) => {
    try { m === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, m); } catch { /* storage unavailable */ }
    setModeState(m);
  }, []);
  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
  return { mode, resolved, setMode };
}
