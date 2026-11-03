// Validation for files that agents hand back (docs/09 §1.8): size cap, real type check by content, safe file names.
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_RUN = 8;
const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface PreparedFile { filename: string; mime: string; size: number; sha256: string; data: Buffer }

/** Letters, digits, dot, dash, underscore and space only; no path parts; always keeps the right extension. */
export function safeFilename(name: unknown, ext: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[.\- ]+|[.\- ]+$/g, '').slice(0, 80);
  return `${stem || 'document'}.${ext}`;
}

/** Returns the decoded file, or throws with a reason. PDFs, and zip bundles (a static site from the Code agent), are accepted; the check is on the bytes, not the claimed type. */
export function prepareFile(payload: Record<string, any>): PreparedFile {
  const b64 = payload.file_b64;
  if (typeof b64 !== 'string' || !b64) throw new Error('no file data');
  if (b64.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8) throw new Error('file is larger than 10 MB');
  const data = Buffer.from(b64, 'base64');
  if (data.length === 0) throw new Error('empty file');
  if (data.length > MAX_FILE_BYTES) throw new Error('file is larger than 10 MB');
  const zip = payload.mime === 'application/zip';
  if (zip ? !data.subarray(0, 4).equals(ZIP_MAGIC) : !data.subarray(0, 5).equals(PDF_MAGIC)) throw new Error(zip ? 'not a zip file' : 'not a PDF');
  return { filename: safeFilename(payload.filename, zip ? 'zip' : 'pdf'), mime: zip ? 'application/zip' : 'application/pdf', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
}
