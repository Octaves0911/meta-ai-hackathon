// Smoke test: signaling, chat paging, notes, end flow. Needs backend on :4000 and migrated Postgres.
// Usage: npm run smoke:room -w @meetpilot/backend
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const B = 'http://localhost:4000';
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const ok = (name, cond) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) process.exitCode = 1; };
const sock = (u) => new Promise((res, rej) => { const s = io(B, { auth: { username: u } }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emitAck = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

for (const u of ['r1', 'r2', 'r3']) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'r1', 'POST', { name: 'RoomTest' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'r1', 'POST', { title: 'rtc', inviteeIds: [id('r2')] })).body;
await api(`/meetings/${M.id}/join`, 'r1', 'POST'); await api(`/meetings/${M.id}/join`, 'r2', 'POST');

const s1 = await sock('r1'), s2 = await sock('r2'), s3 = await sock('r3');
ok('outsider cannot join room', (await emitAck(s3, 'room:join', { meetingId: M.id })).error === 'not_found');
const a1 = await emitAck(s1, 'room:join', { meetingId: M.id });
ok('first peer sees empty room', a1.peers.length === 0);
const joined = once(s1, 'peer:joined');
const a2 = await emitAck(s2, 'room:join', { meetingId: M.id });
ok('second peer sees first', a2.peers.length === 1 && a2.peers[0].name === 'r1');
ok('peer:joined delivered', (await joined).name === 'r2');

const offer = once(s1, 'rtc:offer'); s2.emit('rtc:offer', { to: s1.id, sdp: { type: 'offer', sdp: 'x' } });
const o = await offer; ok('offer relayed with sender', o.from === s2.id && o.sdp.sdp === 'x');
let leaked = false; s3.on('rtc:offer', () => (leaked = true)); s2.emit('rtc:offer', { to: s3.id, sdp: {} });
await new Promise((r) => setTimeout(r, 300)); ok('signaling not relayed outside room', !leaked);

// chat
const live = once(s1, 'chat:message');
for (let i = 1; i <= 35; i++) await api(`/meetings/${M.id}/messages`, 'r2', 'POST', { body: `m${i}` });
ok('chat live broadcast', (await live).body === 'm1');
const p1 = (await api(`/meetings/${M.id}/messages?limit=30`, 'r1')).body;
ok('page 1: 30 newest first', p1.length === 30 && p1[0].body === 'm35');
const p2 = (await api(`/meetings/${M.id}/messages?before=${encodeURIComponent(p1.at(-1).createdAt)}&limit=30`, 'r1')).body;
ok('page 2: older 5', p2.length === 5 && p2[0].body === 'm5');
ok('outsider chat 404', (await api(`/meetings/${M.id}/messages`, 'r3')).status === 404);
ok('empty message rejected', (await api(`/meetings/${M.id}/messages`, 'r2', 'POST', { body: '  ' })).status === 400);

// notes private
await api(`/meetings/${M.id}/notes`, 'r1', 'PUT', { body: 'secret' });
await api(`/meetings/${M.id}/notes`, 'r1', 'PUT', { body: 'secret v2' });
ok('own note saved', (await api(`/meetings/${M.id}/notes`, 'r1')).body.body === 'secret v2');
ok('note not visible to other', (await api(`/meetings/${M.id}/notes`, 'r2')).body.body === '');

// leave via disconnect, duration, end
const left = once(s1, 'peer:left'); s2.disconnect(); ok('peer:left on disconnect', (await left).userId === id('r2'));
await new Promise((r) => setTimeout(r, 1500));
const ended = once(s1, 'meeting:ended');
ok('owner ends', (await api(`/meetings/${M.id}/end`, 'r1', 'POST')).status === 204);
ok('meeting:ended broadcast', (await ended).meetingId === M.id);
const d = (await api(`/meetings/${M.id}`, 'r1')).body;
ok('status ended, duration >= 1', d.status === 'ended' && d.totalDurationSec >= 1);
ok('cannot join room after end', (await emitAck(s3, 'room:join', { meetingId: M.id })).error != null);
s1.disconnect(); s3.disconnect();
for (const u of ['r1', 'r2', 'r3']) await api(`/users/${id(u)}`, u, 'DELETE');
