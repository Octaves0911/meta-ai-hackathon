import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanRelPath, isCodeFile, isTextFile, mimeFor, PathError, resolveInside, summarize } from '../src/services/workspacePaths.js';

test('cleanRelPath normalises and rejects traversal / absolute paths', () => {
  assert.equal(cleanRelPath('docs\\plan.md'), 'docs/plan.md');
  assert.equal(cleanRelPath('./a/b.txt'), 'a/b.txt');
  for (const bad of ['', '/etc/passwd', 'C:\\windows', '../x', 'a/../../x', 'a//b', 'a/./b', 'a\0b', 'x'.repeat(301), '..']) {
    assert.throws(() => cleanRelPath(bad), PathError, JSON.stringify(bad));
  }
});

test('resolveInside stays inside the root, including through symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ws-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(join(root, 'docs'));
  symlinkSync(outside, join(root, 'link'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'docs', 'file-link.txt'));
  assert.ok(resolveInside(root, 'docs/new-file.md').endsWith(join('docs', 'new-file.md')), 'not-yet-existing file is fine');
  assert.throws(() => resolveInside(root, '../escape'), PathError);
  assert.throws(() => resolveInside(root, 'link/secret.txt'), /escapes/, 'symlinked directory');
  assert.throws(() => resolveInside(root, 'link/new.txt'), /escapes/, 'new file under a symlinked directory');
  assert.throws(() => resolveInside(root, 'docs/file-link.txt'), /escapes/, 'symlinked file');
});

test('file type helpers', () => {
  assert.equal(isTextFile('a.md'), true);
  assert.equal(isTextFile('a.pdf', Buffer.from('plain')), false, 'known binary type wins');
  assert.equal(isTextFile('Makefile', Buffer.from('all:\n\techo hi')), true, 'unknown extension, text bytes');
  assert.equal(isTextFile('blob', Buffer.from([1, 2, 0, 3])), false);
  assert.equal(isTextFile('blob'), false);
  assert.equal(isCodeFile('x.ts'), true); assert.equal(isCodeFile('x.md'), false);
  assert.equal(mimeFor('a.PDF'), 'application/pdf'); assert.equal(mimeFor('a.unknown'), 'application/octet-stream');
});

test('summarize picks the first meaningful line', () => {
  assert.equal(summarize('\n\n# Launch plan\nbody', 'a.md'), 'Launch plan');
  assert.equal(summarize('// Computes the invoice total\nfunction f(){}', 'a.ts'), 'Computes the invoice total');
  assert.equal(summarize('  \n  \n', 'empty.txt'), 'empty.txt');
  assert.equal(summarize('x'.repeat(500), 'a.txt').length, 200);
});
