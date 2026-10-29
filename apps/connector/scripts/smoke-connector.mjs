// End-to-end smoke test of the Google integration against a FAKE Google (no real credentials needed).
// Start (all with the same DATABASE_URL / INTERNAL_SECRET):
//   connector: CONNECTOR_SYNC=false TOKEN_ENC_KEY=$(openssl rand -base64 32) GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=y \
//              GOOGLE_AUTH_URL=http://localhost:9095/auth GOOGLE_TOKEN_URL=http://localhost:9095/token GOOGLE_API_BASE=http://localhost:9095 \
//              GOOGLE_REVOKE_URL=http://localhost:9095/revoke GOOGLE_REDIRECT_URI=http://localhost:4000/api/connections/google/callback npm start -w @meetpilot/connector
//   backend:   INSIGHTS_LLM=off INSIGHT_TICK_MS=300 npm start -w @meetpilot/backend
// Then: npm run smoke:connector -w @meetpilot/connector
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const B = 'http://localhost:4000';
const api = async (path, user, method = 'GET', json, extra = {}) => {
  const r = await fetch(B + '/api' + path, { method, redirect: 'manual', ...extra, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = r.status === 204 || r.status === 302 ? null : await r.text();
  return { status: r.status, location: r.headers.get('location'), raw: text, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 300)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(120); } return null; };
const b64 = (s) => Buffer.from(s).toString('base64url');

// ---------------- fake Google ----------------
const day = 86_400_000;
const G = {
  mail: [], files: [], revoked: [], stats: { tokenCalls: 0, refreshCalls: 0, mailGets: 0, mailLists: 0, exports: 0, listCalls: 0 }, failRefresh: false,
  reset() { Object.assign(this.stats, { tokenCalls: 0, refreshCalls: 0, mailGets: 0, mailLists: 0, exports: 0, listCalls: 0 }); },
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = ''; for await (const c of req) body += c;
  const form = new URLSearchParams(body);
  if (u.pathname === '/token') {
    if (form.get('grant_type') === 'refresh_token') {
      G.stats.refreshCalls++;
      if (G.failRefresh) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, { access_token: `AT-refreshed-${G.stats.refreshCalls}`, expires_in: 3600 });
    }
    G.stats.tokenCalls++;
    if (form.get('code') === 'bad-code') return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, { access_token: `AT-secret-${G.stats.tokenCalls}`, refresh_token: `RT-secret-${G.stats.tokenCalls}`, expires_in: form.get('code') === 'short-code' ? 1 : 3600 });
  }
  if (u.pathname === '/revoke') { G.revoked.push(form.get('token')); return json(res, 200, {}); }
  if (!(req.headers.authorization ?? '').startsWith('Bearer AT-')) return json(res, 401, { error: 'unauthorized' });
  if (u.pathname === '/oauth2/v3/userinfo') return json(res, 200, { email: 'alice@example.com' });
  if (u.pathname === '/gmail/v1/users/me/labels') return json(res, 200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Finance', type: 'user' }] });
  if (u.pathname === '/gmail/v1/users/me/messages') {
    G.stats.mailLists++;
    const labels = u.searchParams.getAll('labelIds'); const days = Number(/newer_than:(\d+)d/.exec(u.searchParams.get('q') ?? '')?.[1] ?? 9999);
    return json(res, 200, { messages: G.mail.filter((m) => m.labels.some((l) => labels.includes(l)) && m.daysOld <= days).map((m) => ({ id: m.id })) });
  }
  const mm = /^\/gmail\/v1\/users\/me\/messages\/(.+)$/.exec(u.pathname);
  if (mm) {
    G.stats.mailGets++;
    const m = G.mail.find((x) => x.id === decodeURIComponent(mm[1]));
    if (!m) return json(res, 404, {});
    return json(res, 200, { id: m.id, payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(Date.now() - m.daysOld * day).toUTCString() }], mimeType: 'text/plain', body: { data: b64(m.body) } } });
  }
  if (u.pathname === '/drive/v3/files') {
    G.stats.listCalls++;
    const parent = /'([^']+)' in parents/.exec(u.searchParams.get('q') ?? '')?.[1];
    return json(res, 200, { files: G.files.filter((f) => f.parent === parent && !f.trashed) });
  }
  const dm = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(u.pathname);
  if (dm) {
    const f = G.files.find((x) => x.id === decodeURIComponent(dm[1]));
    if (!f) return json(res, 404, {});
    if (dm[2]) G.stats.exports++;
    res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(f.text ?? '');
  }
  json(res, 404, {});
});
await new Promise((r) => server.listen(9095, r));

// ---------------- scenario ----------------
const U = ['ann', 'ben', 'cat'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'ann', 'POST', { name: 'Integrations' })).body;
await db.query("insert into project_members values ($1,$2,'member')", [P.id, id('ben')]);
const conns = async (user = 'ann') => (await api(`/projects/${P.id}/connections`, user)).body;
const search = async (user, q) => (await api(`/projects/${P.id}/memory/search?q=${encodeURIComponent(q)}`, user)).body;
const items = async () => (await db.query('select external_id, title, author, url, visibility, text from external_items order by external_id')).rows;

G.mail = [
  { id: 'm1', labels: ['Label_1'], daysOld: 3, from: '"Dana Lee" <dana@example.com>', subject: 'Re: Q3 budget', body: 'The Q3 budget is approved at forty thousand dollars for marketing.\n\nOn Mon, Alex wrote:\n> what is the budget?\n' },
  { id: 'm2', labels: ['Label_1'], daysOld: 10, from: 'Eve <eve@example.com>', subject: 'Vendor contract', body: 'The vendor contract renews in January.' },
  { id: 'm3', labels: ['Label_1'], daysOld: 60, from: 'Old <old@example.com>', subject: 'Ancient', body: 'Too old to matter.' },
  { id: 'm4', labels: ['INBOX'], daysOld: 1, from: 'Spam <s@example.com>', subject: 'Not selected', body: 'Unselected label.' },
];
G.files = [
  { id: 'F-docs', name: 'Docs', mimeType: 'application/vnd.google-apps.folder', parent: 'root', modifiedTime: new Date().toISOString() },
  { id: 'F-arch', name: 'Archive', mimeType: 'application/vnd.google-apps.folder', parent: 'root', modifiedTime: new Date().toISOString() },
  { id: 'F-sub', name: 'Specs', mimeType: 'application/vnd.google-apps.folder', parent: 'F-docs', modifiedTime: new Date().toISOString() },
  { id: 'D1', name: 'Launch plan', mimeType: 'application/vnd.google-apps.document', parent: 'F-docs', modifiedTime: '2026-10-01T10:00:00.000Z', webViewLink: 'https://docs.google.com/document/d/D1', text: 'The launch plan targets enterprise customers in November.' },
  { id: 'D2', name: 'notes.txt', mimeType: 'text/plain', parent: 'F-sub', modifiedTime: '2026-10-02T10:00:00.000Z', webViewLink: 'https://drive.google.com/file/d/D2', text: 'Security review is scheduled before the launch.' },
  { id: 'D3', name: 'slides.pdf', mimeType: 'application/pdf', parent: 'F-docs', modifiedTime: '2026-10-03T10:00:00.000Z', text: 'binary' },
  { id: 'D4', name: 'Old note', mimeType: 'application/vnd.google-apps.document', parent: 'F-docs', modifiedTime: '2026-09-01T10:00:00.000Z', text: 'Soon to be trashed.' },
];

// 1. OAuth
const started = await api(`/projects/${P.id}/connections/google/start`, 'ann', 'POST', { services: ['gmail', 'drive'] });
const url = new URL(started.body.url);
ok('auth URL asks for read-only Gmail + Drive and carries a signed state', started.status === 200 && /gmail\.readonly/.test(url.searchParams.get('scope')) && /drive\.readonly/.test(url.searchParams.get('scope')) && !/send|modify/.test(url.searchParams.get('scope')) && url.searchParams.get('state')?.includes('.'), started.body);
ok('only project members may start', (await api(`/projects/${P.id}/connections/google/start`, 'cat', 'POST', { services: ['gmail'] })).status === 404);
const state = url.searchParams.get('state');
const bad = await api(`/connections/google/callback?code=good&state=${state.slice(0, -3)}xyz`);
ok('tampered state is rejected', bad.status === 302 && /error=invalid_state/.test(bad.location), bad.location);
ok('bad authorisation code is rejected', /error=oauth_failed/.test((await api(`/connections/google/callback?code=bad-code&state=${state}`)).location ?? ''));
const cb = await api(`/connections/google/callback?code=good-code&state=${state}`);
ok('callback redirects back to the app', cb.status === 302 && cb.location === '/dashboard/integrations?connected=1', cb.location);
let list = await conns();
ok('both services connected, private by default, awaiting setup', list.length === 2 && list.every((c) => c.visibility === 'private' && c.status === 'needs_setup' && c.account === 'alice@example.com' && c.isOwner), list);
const gm = list.find((c) => c.provider === 'gmail'), dr = list.find((c) => c.provider === 'drive');
ok('tokens never appear in any API response', !JSON.stringify(list).match(/AT-|RT-|token|secret/i), list);
const row = (await db.query('select token_ciphertext, token_iv, token_tag from connections where id=$1', [gm.id])).rows[0];
ok('tokens are encrypted at rest', row.token_ciphertext.length > 20 && row.token_iv.length === 12 && row.token_tag.length === 16 && !Buffer.concat([row.token_ciphertext]).toString('latin1').includes('RT-secret') && !row.token_ciphertext.toString('base64').includes('RT-secret'));

// 2. nothing is read until the user chooses
G.reset();
await api(`/connections/${gm.id}/sync`, 'ann', 'POST'); await api(`/connections/${dr.id}/sync`, 'ann', 'POST');
ok('no mail or Drive data read before the user selects what to sync', G.stats.mailLists === 0 && G.stats.mailGets === 0 && G.stats.listCalls === 0 && (await items()).length === 0, G.stats);

// 3. Gmail setup + sync
const labels = (await api(`/connections/${gm.id}/gmail/labels`, 'ann')).body;
ok('label picker lists Gmail labels', labels.some((l) => l.id === 'Label_1' && l.name === 'Finance'), labels);
ok('lookback outside 7-365 rejected', (await api(`/connections/${gm.id}`, 'ann', 'PUT', { lookbackDays: 3 })).status === 400);
ok('configure labels + lookback', (await api(`/connections/${gm.id}`, 'ann', 'PUT', { labels: ['Label_1'], lookbackDays: 30 })).status === 204);
const mailItems = await waitFor(async () => { const r = (await items()).filter((i) => i.url?.includes('mail.google')); return r.length === 2 && r; });
ok('only selected label within the window is indexed (2 of 4)', !!mailItems && mailItems.map((i) => i.external_id).join() === 'm1,m2', mailItems);
ok('mail metadata kept; quoted reply stripped; link to Gmail', mailItems?.[0].title === 'Re: Q3 budget' && mailItems[0].author === 'Dana Lee' && !mailItems[0].text.includes('what is the budget') && /mail\.google\.com/.test(mailItems[0].url), mailItems?.[0]);
ok('items start private', mailItems.every((i) => i.visibility === 'private'));
list = await conns();
ok('status connected with count and last sync', list.find((c) => c.id === gm.id).status === 'connected' && list.find((c) => c.id === gm.id).itemCount === 2 && !!list.find((c) => c.id === gm.id).lastSyncAt, list);

// 4. privacy: private by default, sharing needs confirmation, items follow visibility
ok('owner finds her private mail via memory search', (await search('ann', 'Q3 budget approved')).external.length >= 1);
ok('another member cannot see it', (await search('ben', 'Q3 budget approved')).external.length === 0);
ok("another member does not see the owner's private connections", (await conns('ben')).length === 0);
ok('sharing without confirmation refused', (await api(`/connections/${gm.id}`, 'ann', 'PUT', { visibility: 'project' })).status === 400);
ok('non-owner cannot change or sync or delete', (await api(`/connections/${gm.id}`, 'ben', 'PUT', { visibility: 'project', confirmShare: true })).status === 404 && (await api(`/connections/${gm.id}/sync`, 'ben', 'POST')).status === 404 && (await api(`/connections/${gm.id}`, 'ben', 'DELETE')).status === 404);

// 5. private insight routing (live meeting): only the owner's AI Notes
const M = (await api(`/projects/${P.id}/meetings`, 'ann', 'POST', { title: 'Budget sync', inviteeIds: [id('ben')] })).body.id;
for (const u of ['ann', 'ben']) await api(`/meetings/${M}/join`, u, 'POST');
await api(`/meetings/${M}/ai-assist`, 'ann', 'PUT', { enabled: true });
await db.query("insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,'ann','What is the Q3 budget?',1)", [M, id('ann')]);
const priv = await waitFor(async () => (await api(`/meetings/${M}/insights`, 'ann')).body.find((i) => i.private && /Gmail/.test(i.sourceLabel ?? '')));
ok("insight from a private source reaches only its owner's AI Notes", !!priv && priv.deliveredToChat === false && /Dana Lee/.test(priv.sourceLabel), priv);
ok('other participants never see it (notes or chat)', !(await api(`/meetings/${M}/insights`, 'ben')).body.some((i) => /Gmail/.test(i.sourceLabel ?? '')) && !(await api(`/meetings/${M}/messages?limit=50`, 'ben')).body.some((m) => m.insight && /Gmail/.test(m.insight.sourceLabel ?? '')));

// 6. share with the project: items follow; shared chat may now cite them
ok('sharing with confirmation accepted', (await api(`/connections/${gm.id}`, 'ann', 'PUT', { visibility: 'project', confirmShare: true })).status === 204);
ok('stored items re-audienced immediately', (await items()).filter((i) => i.url?.includes('mail.google')).every((i) => i.visibility === 'project'));
ok('member now sees the shared connection (read-only) and its mail', (await conns('ben')).some((c) => c.provider === 'gmail' && !c.isOwner && c.config.labels.length === 0) && (await search('ben', 'Q3 budget approved')).external.length >= 1);
await db.query("insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,'ann','Is the Q3 budget approved?',2)", [M, id('ann')]);
const shared = await waitFor(async () => (await api(`/meetings/${M}/messages?limit=50`, 'ben')).body.find((m) => m.insight && /Gmail/.test(m.insight.sourceLabel ?? '')));
ok('shared source can be cited in the shared chat with its source', !!shared && shared.insight.private === false, shared);
ok('sharing back to private hides it again', (await api(`/connections/${gm.id}`, 'ann', 'PUT', { visibility: 'private' })).status === 204 && (await search('ben', 'Q3 budget approved')).external.length === 0);

// 7. changes in Gmail are reflected: removed message deleted, no duplicates
G.mail = G.mail.filter((m) => m.id !== 'm2'); G.mail.push({ id: 'm5', labels: ['Label_1'], daysOld: 1, from: 'Fay <fay@example.com>', subject: 'New thread', body: 'Fresh content.' });
G.reset(); await api(`/connections/${gm.id}/sync`, 'ann', 'POST');
const after = (await items()).filter((i) => i.url?.includes('mail.google')).map((i) => i.external_id).join();
ok('resync adds new mail and removes deleted mail, no duplicates', after === 'm1,m5', after);
ok('only new messages are fetched (mail is immutable)', G.stats.mailGets === 1, G.stats);

// 8. Drive
const roots = (await api(`/connections/${dr.id}/drive/folders`, 'ann')).body;
ok('folder browser lists folders only', roots.map((f) => f.name).join() === 'Archive,Docs', roots);
ok('sub-folders browsable', (await api(`/connections/${dr.id}/drive/folders?parent=F-docs`, 'ann')).body.map((f) => f.name).join() === 'Specs');
await api(`/connections/${dr.id}`, 'ann', 'PUT', { folderIds: ['F-docs'], includeSubfolders: true });
const docs = await waitFor(async () => { const r = (await items()).filter((i) => ['D1', 'D2', 'D3', 'D4'].includes(i.external_id)); return r.length === 3 && r; });
ok('docs and text files from the folder and sub-folders indexed; unsupported types skipped', !!docs && docs.map((d) => d.external_id).join() === 'D1,D2,D4', docs);
ok('Drive items link back to the file and are private', docs?.[0].url === 'https://docs.google.com/document/d/D1' && docs.every((d) => d.visibility === 'private'));
G.files.find((f) => f.id === 'D1').text = 'The launch plan now targets small businesses in December.'; G.files.find((f) => f.id === 'D1').modifiedTime = '2026-10-20T10:00:00.000Z';
G.files.find((f) => f.id === 'D4').trashed = true;
G.reset(); await api(`/connections/${dr.id}/sync`, 'ann', 'POST');
const d2 = (await items()).filter((i) => ['D1', 'D2', 'D4'].includes(i.external_id));
ok('edited file re-indexed, trashed file removed', d2.map((d) => d.external_id).join() === 'D1,D2' && /small businesses/.test(d2[0].text), d2);
ok('unchanged files are not re-downloaded', G.stats.exports === 1, G.stats);
await api(`/connections/${dr.id}`, 'ann', 'PUT', { includeSubfolders: false });
await waitFor(async () => !(await items()).some((i) => i.external_id === 'D2'));
ok('turning off sub-folders drops their files', !(await items()).some((i) => i.external_id === 'D2'));

// 9. token refresh + revoked grant
G.reset();
await api(`/projects/${P.id}/connections/google/start`, 'ann', 'POST', { services: ['gmail'] }).then(async (r) => api(`/connections/google/callback?code=short-code&state=${new URL(r.body.url).searchParams.get('state')}`));
const gm2 = (await conns()).find((c) => c.provider === 'gmail');
ok('reconnecting reuses the connection and resets it for setup', gm2.id === gm.id && gm2.status === 'needs_setup', gm2);
await api(`/connections/${gm.id}`, 'ann', 'PUT', { labels: ['Label_1'] });
await sleep(1500);
await api(`/connections/${gm.id}/sync`, 'ann', 'POST');
ok('expired access token is refreshed automatically', G.stats.refreshCalls >= 1 && (await conns()).find((c) => c.id === gm.id).status === 'connected', G.stats);
const sealed1 = (await db.query('select token_ciphertext from connections where id=$1', [gm.id])).rows[0].token_ciphertext;
G.failRefresh = true; await db.query("update connections set token_ciphertext = token_ciphertext where id=$1", [gm.id]);
// force expiry by reconnecting with the short-lived token again, then fail the refresh
await api(`/projects/${P.id}/connections/google/start`, 'ann', 'POST', { services: ['gmail'] }).then(async (r) => api(`/connections/google/callback?code=short-code&state=${new URL(r.body.url).searchParams.get('state')}`));
await api(`/connections/${gm.id}`, 'ann', 'PUT', { labels: ['Label_1'] }); await sleep(1500);
const failed = await api(`/connections/${gm.id}/sync`, 'ann', 'POST');
const afterFail = (await conns()).find((c) => c.id === gm.id);
ok('revoked grant => clear error state asking to reconnect, no secrets leaked', failed.status === 409 && afterFail.status === 'error' && /reconnect/i.test(afterFail.lastError ?? '') && !JSON.stringify(afterFail).match(/RT-|AT-/), [failed.status, afterFail]);
G.failRefresh = false;

// 10. disconnect deletes everything and revokes at Google
const itemsBefore = (await items()).filter((i) => i.url?.includes('mail.google')).length;
G.revoked.length = 0;
ok('disconnect accepted', (await api(`/connections/${gm.id}`, 'ann', 'DELETE')).status === 204);
ok('token revoked at Google', G.revoked.length === 1 && G.revoked[0].startsWith('RT-secret'), G.revoked);
ok('connection and every indexed item deleted', itemsBefore > 0 && (await db.query('select 1 from connections where id=$1', [gm.id])).rowCount === 0 && (await items()).filter((i) => i.url?.includes('mail.google')).length === 0);

// 11. deleting the project revokes and purges the rest
G.revoked.length = 0;
ok('project deletion accepted', (await api(`/projects/${P.id}`, 'ann', 'DELETE')).status === 204);
ok('remaining connections revoked and purged', G.revoked.length >= 1 && (await db.query('select 1 from connections where project_id=$1', [P.id])).rowCount === 0 && (await items()).length === 0, G.revoked);

server.close();
for (const u of U) await api(`/users/${id(u)}`, u, 'DELETE');
await db.end();
process.exit(process.exitCode ?? 0);
