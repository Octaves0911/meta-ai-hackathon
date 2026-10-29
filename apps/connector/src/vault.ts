// Token vault: AES-256-GCM with a per-row random IV. Tokens never leave this service, are never logged, and are
// never sent to a model (docs/06). TOKEN_ENC_KEY is 32 bytes, base64-encoded.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed { ciphertext: Buffer; iv: Buffer; tag: Buffer }
export interface Tokens { access_token: string; refresh_token?: string; expires_at: number }

export class VaultError extends Error {}

function key(): Buffer {
  const k = Buffer.from(process.env.TOKEN_ENC_KEY ?? '', 'base64');
  if (k.length !== 32) throw new VaultError('TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
  return k;
}
export const vaultConfigured = () => Buffer.from(process.env.TOKEN_ENC_KEY ?? '', 'base64').length === 32;

export function seal(tokens: Tokens): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([c.update(JSON.stringify(tokens), 'utf8'), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

export function open(s: Sealed): Tokens {
  const d = createDecipheriv('aes-256-gcm', key(), s.iv);
  d.setAuthTag(s.tag);
  return JSON.parse(Buffer.concat([d.update(s.ciphertext), d.final()]).toString('utf8'));
}
