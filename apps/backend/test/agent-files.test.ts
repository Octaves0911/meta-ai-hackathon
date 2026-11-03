import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILE_BYTES, prepareFile, safeFilename } from '../src/agents/files.js';

const pdf = (extra = '') => Buffer.from(`%PDF-1.4\n${extra}`).toString('base64');

test('a real PDF is accepted and described (size, hash, type)', () => {
  const f = prepareFile({ file_b64: pdf('hello'), filename: 'report.pdf' });
  assert.equal(f.mime, 'application/pdf');
  assert.equal(f.filename, 'report.pdf');
  assert.equal(f.size, f.data.length);
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test('the content decides the type, not the claim', () => {
  assert.throws(() => prepareFile({ file_b64: Buffer.from('<html><script>alert(1)</script>').toString('base64'), filename: 'x.pdf' }), /not a PDF/);
  assert.throws(() => prepareFile({ file_b64: Buffer.from('MZ\x90\x00exe').toString('base64'), filename: 'x.pdf', mime: 'application/pdf' }), /not a PDF/);
});

test('empty, missing and oversized files are refused', () => {
  assert.throws(() => prepareFile({}), /no file data/);
  assert.throws(() => prepareFile({ file_b64: '' }), /no file data/);
  assert.throws(() => prepareFile({ file_b64: Buffer.alloc(MAX_FILE_BYTES + 10, 1).toString('base64') }), /10 MB/);
  const exactlyTooBig = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_FILE_BYTES, 1)]).toString('base64');
  assert.throws(() => prepareFile({ file_b64: exactlyTooBig }), /10 MB/);
});

test('file names cannot carry paths, control characters or the wrong extension', () => {
  assert.equal(safeFilename('../../etc/passwd', 'pdf'), 'passwd.pdf');
  assert.equal(safeFilename('C:\\Users\\x\\plan.exe', 'pdf'), 'plan.pdf');
  assert.equal(safeFilename('Q4 launch plan (final)!!.PDF', 'pdf'), 'Q4 launch plan -final.pdf');
  assert.equal(safeFilename('a\r\nb: evil.pdf', 'pdf').includes('\n'), false);
  assert.equal(safeFilename('', 'pdf'), 'document.pdf');
  assert.equal(safeFilename('...', 'pdf'), 'document.pdf');
  assert.ok(safeFilename('x'.repeat(500), 'pdf').length <= 84);
});
