import { HttpError } from '../errors.js';

const base = () => process.env.CONNECTOR_URL ?? 'http://localhost:6100';

/** Call the connector with the shared secret; connector errors are passed through with their status and message. */
export async function connector<T = unknown>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '', ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HttpError(503, 'connector_unavailable', 'the integrations service is not reachable');
  }
  if (res.status === 204) return undefined as T;
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 401 ? 502 : res.status, body?.error?.code ?? 'connector_error', body?.error?.message ?? 'integration request failed');
  return body as T;
}
