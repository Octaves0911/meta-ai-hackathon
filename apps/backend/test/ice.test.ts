import test from 'node:test';
import assert from 'node:assert/strict';
import { iceServers } from '../src/routes/ice.js';

test('STUN by default, TURN only when all three settings are present', () => {
  assert.deepEqual(iceServers({}), [{ urls: ['stun:stun.l.google.com:19302'] }]);
  assert.equal(iceServers({ TURN_URLS: 'turn:a.example:3478' }).length, 1);                 // no credentials: no relay offered
  const full = iceServers({ TURN_URLS: 'turn:a.example:3478, turns:a.example:5349', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p', STUN_URLS: 'stun:s.example:3478' });
  assert.deepEqual(full, [{ urls: ['stun:s.example:3478'] }, { urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'u', credential: 'p' }]);
});

test('anything that is not a stun/turn URL is ignored', () => {
  const out = iceServers({ TURN_URLS: 'http://evil.example, javascript:alert(1), turn:ok.example:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.deepEqual(out[1], { urls: ['turn:ok.example:3478'], username: 'u', credential: 'p' });
});
