import test from 'node:test';
import assert from 'node:assert/strict';
import { stateOf } from '../src/agents/attachments.js';

const file = (attachable: boolean) => ({ artifactId: 'a', filename: 'r.pdf', size: 10, attachable });
const row = (status: string, o: Partial<{ revision: number; step_label: string | null; files: any[] | null }> = {}) => ({ status, revision: 0, step_label: null, files: null, ...o });

test('only approved work with an attachable PDF is ready', () => {
  assert.equal(stateOf(row('approved', { files: [file(true)] })).state, 'ready');
  assert.equal(stateOf(row('approved', { files: [file(false)] })).state, 'no_file');
  assert.equal(stateOf(row('approved')).state, 'no_file');
});

test('work in review waits for approval, work in progress shows the current step', () => {
  assert.equal(stateOf(row('awaiting_review', { files: [file(false)] })).state, 'awaiting_approval');
  assert.deepEqual(stateOf(row('running', { step_label: 'Search the web' })), { state: 'working', label: 'Agent working: Search the web' });
  assert.equal(stateOf(row('routed')).label, 'Waiting to start');
  assert.equal(stateOf(row('changes_requested')).state, 'working');
});

test('rejected, failed and unrouted work will never produce a file', () => {
  for (const s of ['rejected', 'failed', 'skipped_human']) assert.equal(stateOf(row(s)).state, 'failed', s);
});

test('a draft file that is not yet approved is never reported as ready, even on approved work', () => {
  assert.equal(stateOf(row('approved', { files: [file(false), file(false)] })).state, 'no_file');
  assert.equal(stateOf(row('awaiting_review', { files: [file(true)] })).state, 'awaiting_approval');
});
