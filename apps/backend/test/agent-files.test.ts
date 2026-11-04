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

test('a zip bundle is accepted by its bytes and never mistaken for a PDF', () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest')]);
  const f = prepareFile({ file_b64: zip.toString('base64'), filename: '../site.html', mime: 'application/zip' });
  assert.equal(f.mime, 'application/zip');
  assert.equal(f.filename, 'site.zip');
  assert.throws(() => prepareFile({ file_b64: Buffer.from('%PDF-1.4 x').toString('base64'), filename: 'x.zip', mime: 'application/zip' }), /not a zip/);
  assert.throws(() => prepareFile({ file_b64: zip.toString('base64'), filename: 'x.pdf', mime: 'application/pdf' }), /not a PDF/);
});

test('a PowerPoint deck is accepted by its bytes with the right name and type', async () => {
  const { PPTX_MIME } = await import('../src/agents/files.js');
  const pk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('deck')]);
  const f = prepareFile({ file_b64: pk.toString('base64'), filename: '../Launch deck.pdf', mime: PPTX_MIME });
  assert.equal(f.mime, PPTX_MIME);
  assert.equal(f.filename, 'Launch deck.pptx');
  assert.throws(() => prepareFile({ file_b64: Buffer.from('%PDF-1.4 x').toString('base64'), filename: 'x.pptx', mime: PPTX_MIME }), /not a PowerPoint/);
});
