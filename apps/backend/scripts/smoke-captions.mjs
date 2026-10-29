// Smoke test for the /stt proxy against a fake Deepgram server.
// Start the backend first:  STT_MODE=stream DEEPGRAM_API_KEY=testkey DEEPGRAM_URL=ws://localhost:9099/v1/listen npm start
// Then: npm run smoke:captions -w @meetpilot/backend
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const { WebSocket, WebSocketServer } = require('ws');
const B = 'http://localhost:4000';
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: r.status === 204 ? null : ct.includes('json') ? await r.json() : await r.text() };
};
const ok = (name, cond) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

// --- fake Deepgram ---
const dg = { connections: 0, auth: [], urls: [], bytes: 0 };
const wss = new WebSocketServer({ port: 9099 });
wss.on('connection', (ws, req) => {
  dg.connections++; dg.auth.push(req.headers.authorization); dg.urls.push(req.url);
  ws.on('message', (d, bin) => { if (bin) dg.bytes += d.length; });
  ws.fake = true;
});
const results = (text, final) => JSON.stringify({ type: 'Results', is_final: final, start: 1.5, channel: { alternatives: [{ transcript: text, confidence: 0.95 }] } });
const broadcast = (m) => wss.clients.forEach((c) => c.send(m));

for (const u of ['c1', 'c2', 'c3']) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'c1', 'POST', { name: 'Caps' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'c1', 'POST', { title: 'captions', inviteeIds: [id('c2')] })).body;
await api(`/meetings/${M.id}/join`, 'c1', 'POST'); await api(`/meetings/${M.id}/join`, 'c2', 'POST');

const room = io(B, { auth: { username: 'c2' } });
await once(room, 'connect'); await new Promise((r) => room.emit('room:join', { meetingId: M.id }, r));
const stt = (user, mid = M.id) => new WebSocket(`ws://localhost:4000/stt?meetingId=${mid}&user=${user}`);
const closeOf = (ws) => new Promise((r) => ws.on('close', (code) => r(code)));

ok('outsider denied with 4001', (await closeOf(stt('c3'))) === 4001);

const ws = stt('c1'); await once(ws, 'open');
const interimP = once(room, 'caption:interim'), finalP = once(room, 'caption:final');
const frame = Buffer.alloc(3200, 1);
for (let i = 0; i < 5; i++) ws.send(frame);
await sleep(500);
ok('Deepgram got token auth', dg.auth[0] === 'Token testkey');
ok('Deepgram url has linear16 16k + interim', /encoding=linear16/.test(dg.urls[0]) && /sample_rate=16000/.test(dg.urls[0]) && /interim_results=true/.test(dg.urls[0]));
ok('audio forwarded', dg.bytes === 5 * 3200);
broadcast(results('hello wor', false)); broadcast(results('hello world', true));
const interim = await interimP, final = await finalP;
ok('interim mirrored to room with speaker', interim.text === 'hello wor' && interim.speaker === 'c1' && interim.userId === id('c1'));
ok('final mirrored with seq 1', final.text === 'hello world' && final.seq === 1);

// reconnect: kill upstream, send more audio, expect a new upstream connection + continued captions
wss.clients.forEach((c) => c.terminate());
await sleep(100); for (let i = 0; i < 3; i++) ws.send(frame);
await sleep(900);
ok('proxy reconnected upstream', dg.connections >= 2);
const final2P = once(room, 'caption:final'); broadcast(results('second line', true));
ok('captions continue after reconnect (seq 2)', (await final2P).seq === 2);

// persistence + export
const json = (await api(`/meetings/${M.id}/transcript`, 'c1')).body;
ok('2 segments saved in order', json.length === 2 && json[0].text === 'hello world' && json[1].seq === 2 && json[0].speaker === 'c1');
ok('txt export', /^\[\d\d:\d\d:\d\d\] c1: hello world\n/.test((await api(`/meetings/${M.id}/transcript?format=txt`, 'c2')).body));
ok('srt export', /^1\n\d\d:\d\d:\d\d,\d{3} --> /.test((await api(`/meetings/${M.id}/transcript?format=srt`, 'c1')).body));
ok('outsider transcript 404', (await api(`/meetings/${M.id}/transcript`, 'c3')).status === 404);

// import
ok('non-owner import forbidden', (await api(`/meetings/${M.id}/transcript/import`, 'c2', 'POST', { text: 'A: hi' })).status === 403);
ok('garbage import rejected', (await api(`/meetings/${M.id}/transcript/import`, 'c1', 'POST', { text: '   ' })).status === 400);
ok('import appends', (await api(`/meetings/${M.id}/transcript/import`, 'c1', 'POST', { text: '[00:00:10] Zed: imported line' })).body.imported === 1);
ok('import continues seq', (await api(`/meetings/${M.id}/transcript`, 'c1')).body.at(-1).seq === 3);
await api(`/meetings/${M.id}/transcript/import`, 'c1', 'POST', { text: 'Only: one', replace: true });
ok('import replace', (await api(`/meetings/${M.id}/transcript`, 'c1')).body.length === 1);

// ending the meeting closes capture
const endClose = closeOf(ws);
await api(`/meetings/${M.id}/end`, 'c1', 'POST');
ok('stt closed with 4001 on end', (await endClose) === 4001);
ok('cannot open stt after end', (await closeOf(stt('c1'))) === 4001);

room.disconnect(); wss.close();
for (const u of ['c1', 'c2', 'c3']) await api(`/users/${id(u)}`, u, 'DELETE');
process.exit(process.exitCode ?? 0);
