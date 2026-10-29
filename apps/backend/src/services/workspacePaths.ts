// Workspace path safety and file-type helpers. Pure (plus realpath checks) and unit-tested.
import { realpathSync } from 'node:fs';
import { basename, dirname, extname, resolve, sep } from 'node:path';

export class PathError extends Error {}

/** A relative, normalised path with no traversal, no absolute form, no NUL bytes. */
export function cleanRelPath(input: string): string {
  const p = input.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!p || p.length > 300) throw new PathError('invalid path length');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) throw new PathError('path must be relative');
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new PathError('path must not contain empty, . or .. segments');
  return segs.join('/');
}

/** Resolve `rel` under `root` and prove (after following symlinks) that the result is still inside `root`. */
export function resolveInside(root: string, rel: string): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, cleanRelPath(rel));
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new PathError('path escapes the workspace');
  // The file may not exist yet (new upload): check the nearest existing ancestor instead.
  let probe = target;
  for (;;) {
    try { const real = realpathSync(probe); if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new PathError('path escapes the workspace'); break; }
    catch (e) { if (e instanceof PathError) throw e; const up = dirname(probe); if (up === probe) break; probe = up; }
  }
  return target;
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.csv', '.tsv', '.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.xml', '.html', '.htm', '.css', '.scss', '.svg',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.graphql', '.log', '.tex']);
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.graphql', '.css', '.scss', '.html', '.htm']);
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.csv': 'text/csv',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const MAX_TEXT_BYTES = 1_000_000;   // larger files are listed but neither edited in the browser nor embedded
export const MAX_SCAN_BYTES = 5_000_000;   // local scan skips anything bigger

export const mimeFor = (name: string) => MIME[extname(name).toLowerCase()] ?? (TEXT_EXT.has(extname(name).toLowerCase()) ? 'text/plain' : 'application/octet-stream');
export const isCodeFile = (name: string) => CODE_EXT.has(extname(name).toLowerCase());
export const isImage = (name: string) => mimeFor(name).startsWith('image/');

/** Text if the extension says so, otherwise if the first bytes contain no NUL. */
export function isTextFile(name: string, sample?: Buffer): boolean {
  const ext = extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (MIME[ext] || !sample) return false;
  return !sample.subarray(0, 8000).includes(0);
}

/** First heading or first non-empty line, trimmed (cheap, offline "summary" shown in the tree and search). */
export function summarize(text: string, name: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(#+|\/\/|\/\*+|\*|--|"""|'''|<!--)\s*/, '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
    if (line.length >= 3) return line.slice(0, 200);
  }
  return basename(name);
}

export const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target']);
