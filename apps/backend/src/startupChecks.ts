const DEV_SECRETS = new Set(['dev-only-change-me', 'changeme', 'secret', 'password']);

/** Production must not run with the example secret or a weak one. Returns the problems found (empty = fine). */
export function secretProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const secret = env.INTERNAL_SECRET ?? '';
  if (!secret) return ['INTERNAL_SECRET is not set'];
  if (env.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  if (DEV_SECRETS.has(secret)) out.push('INTERNAL_SECRET is still the example value');
  if (secret.length < 24) out.push('INTERNAL_SECRET must be at least 24 characters in production');
  return out;
}
