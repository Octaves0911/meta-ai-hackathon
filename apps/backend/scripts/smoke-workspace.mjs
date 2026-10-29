// Smoke test: uploads, sharing rules, indexing/search, editing, local folder scan + watcher, path safety.
// Start the backend with:  WORKSPACE_DIR=/tmp/ws-cloud WORKSPACE_LOCAL_BASE=/tmp/ws-base WORKSPACE_MAX_UPLOAD_MB=1 WORKSPACE_WATCH_DEBOUNCE_MS=200 npm start
// Run with the SAME WORKSPACE_DIR / WORKSPACE_LOCAL_BASE:  npm run smoke:workspace -w @meetpilot/backend
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const B = 'http://localhost:4000';
const CLOUD = process.env.WORKSPACE_DIR, BASE = process.env.WORKSPACE_LOCAL_BASE;
if (!CLOUD || !BASE) { console.error('set WORKSPACE_DIR and WORKSPACE_LOCAL_BASE'); process.exit(2); }
const api = async (path, user, method = 'GET', json, form) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: form ?? (json ? JSON.stringify(json) : undefined) });
  const ct = r.headers.get('content-type') ?? '';
  const raw = r.status === 204 ? null : ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, body: raw, headers: r.headers };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 300)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const form = (dir, files) => { const f = new FormData(); if (dir !== undefined) f.append('dir', dir); for (const [name, content] of files) f.append('files', new Blob([content]), name); return f; };

const U = ['wowner', 'wmember', 'winvitee', 'wout'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'wowner', 'POST', { name: 'WS' })).body;
await db.query("insert into project_members values ($1,$2,'member')", [P.id, id('wmember')]);
const M = (await api(`/projects/${P.id}/meetings`, 'wowner', 'POST', { title: 'Sync', inviteeIds: [id('winvitee')] })).body.id;
const list = async (user = 'wowner') => (await api(`/projects/${P.id}/files`, user)).body;
const ctx = async (q, user = 'wowner') => (await api(`/projects/${P.id}/memory/search?q=${encodeURIComponent(q)}`, user)).body;

// ---- access ----
ok('owner can open an empty workspace', (await api(`/projects/${P.id}/files`, 'wowner')).status === 200);
ok('member is refused until the owner shares', (await api(`/projects/${P.id}/files`, 'wmember')).body?.error?.code === 'workspace_not_shared');
ok('outsiders and unshared invitees cannot even see the project', (await api(`/projects/${P.id}/files`, 'wout')).status === 404 && (await api(`/projects/${P.id}/files`, 'winvitee')).status === 404);

// ---- upload ----
const up = await api(`/projects/${P.id}/files`, 'wowner', 'POST', undefined, form('docs', [
  ['plan.md', '# Launch plan\nWe target enterprise customers in November.'], ['notes.txt', 'Security review happens before launch.'],
  ['invoice.ts', '// Computes the invoice total\nexport function computeInvoiceTotal(items: number[]) { return items.reduce((a, b) => a + b, 0); }'],
  ['logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])], ['../evil.txt', 'sneaky'], ['big.bin', Buffer.alloc(2 * 1024 * 1024, 1)],
]));
ok('multi-file upload: good files stored, too-large file rejected with a reason', up.status === 201 && up.body.uploaded.length === 5 && up.body.rejected.some((r) => r.name === 'big.bin' && /MB/.test(r.reason)), up.body);
ok('file names are reduced to their base name (no traversal via filename)', up.body.uploaded.some((f) => f.path === 'docs/evil.txt') && !existsSync(join(CLOUD, '..', 'evil.txt')));
const bad = await api(`/projects/${P.id}/files`, 'wowner', 'POST', undefined, form('../escape', [['x.txt', 'x']]));
ok('a traversal directory is rejected', bad.status === 400 && bad.body.rejected[0]?.reason, bad.body);
let files = await list();
const plan = files.find((f) => f.path === 'docs/plan.md'), png = files.find((f) => f.path === 'docs/logo.png'), ts = files.find((f) => f.path === 'docs/invoice.ts');
ok('tree data: paths, summaries, text flag', plan.summary === 'Launch plan' && plan.textual === true && png.textual === false && ts.summary === 'Computes the invoice total' && plan.kind === 'cloud', files);

// ---- read / raw ----
const got = await api(`/files/${plan.id}`, 'wowner');
ok('text content is returned for the editor', got.body.content.includes('enterprise customers') && got.body.path === 'docs/plan.md');
const raw = await api(`/files/${png.id}/raw`, 'wowner');
ok('images are served inline, sandboxed and nosniff', raw.status === 200 && raw.headers.get('content-type') === 'image/png' && /inline/.test(raw.headers.get('content-disposition')) && raw.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(raw.headers.get('content-security-policy')));
const rawTxt = await api(`/files/${plan.id}/raw`, 'wowner');
ok('other types are forced to download as opaque bytes', /attachment/.test(rawTxt.headers.get('content-disposition')) && rawTxt.headers.get('content-type') === 'application/octet-stream');

// ---- indexing ----
ok('documents are searchable by meaning (context package files)', (await ctx('enterprise customers November launch')).files.some((h) => /docs\/plan\.md/.test(h.text)));
ok('code is indexed as code', (await db.query("select 1 from memory_chunks where source_id=$1 and source_type='code'", [ts.id])).rowCount >= 1 && (await ctx('invoice total items')).files.some((h) => h.sourceType === 'code'));
ok('binary files are listed but not embedded', (await db.query('select 1 from memory_chunks where source_id=$1', [png.id])).rowCount === 0);
const s1 = await api(`/projects/${P.id}/files/search?q=plan`, 'wowner'); const s2 = await api(`/projects/${P.id}/files/search?q=${encodeURIComponent('invoice total')}`, 'wowner');
ok('search finds by file name and by content', s1.body.some((f) => f.path === 'docs/plan.md') && s2.body.some((f) => f.path === 'docs/invoice.ts'), [s1.body.length, s2.body.length]);

// ---- edit ----
const edit = await api(`/files/${plan.id}`, 'wowner', 'PUT', { content: '# Launch plan\nNow we target small businesses in December.' });
ok('editing saves to storage and refreshes the index', edit.status === 200 && readFileSync(join(CLOUD, P.id, 'docs/plan.md'), 'utf8').includes('small businesses')
  && (await ctx('small businesses December')).files.some((h) => /small businesses/.test(h.text)) && !(await db.query("select text from memory_chunks where source_id=$1", [plan.id])).rows.some((r) => /enterprise/.test(r.text)));
ok('binary files cannot be saved as text; huge content refused', (await api(`/files/${png.id}`, 'wowner', 'PUT', { content: 'x' })).status === 415 && (await api(`/files/${plan.id}`, 'wowner', 'PUT', { content: 'x'.repeat(1_200_000) })).status === 400);

// ---- sharing rules ----
await api(`/projects/${P.id}/workspace`, 'wowner', 'PUT', { shareWorkspace: true });
ok('only the owner changes sharing', (await api(`/projects/${P.id}/workspace`, 'wmember', 'PUT', { shareWorkspace: false })).status === 403);
ok('shared workspace: members read and write', (await list('wmember')).length === 5 && (await api(`/files/${plan.id}`, 'wmember', 'PUT', { content: '# Launch plan\nmember edit' })).status === 200
  && (await api(`/projects/${P.id}/files`, 'wmember', 'POST', undefined, form('', [['member.md', '# From member']]))).status === 201);
await db.query('update meetings set share_workspace = true where id = $1', [M]);
ok('invitees get read-only access when the meeting allows it', (await list('winvitee')).length === 6 && (await api(`/files/${plan.id}`, 'winvitee')).status === 200);
ok('invitees cannot edit, upload or delete', (await api(`/files/${plan.id}`, 'winvitee', 'PUT', { content: 'x' })).body?.error?.code === 'read_only' && (await api(`/projects/${P.id}/files`, 'winvitee', 'POST', undefined, form('', [['x.md', 'x']]))).status === 403 && (await api(`/files/${plan.id}`, 'winvitee', 'DELETE')).status === 403);
const info = (await api(`/projects/${P.id}/workspace`, 'winvitee')).body;
ok('workspace info reports the caller\'s level and hides server folders from non-owners', info.level === 'read' && info.isOwner === false && info.localFolders.length === 0, info);
await db.query('update meetings set share_workspace = false where id = $1', [M]);
ok('revoking meeting access closes it again', (await api(`/projects/${P.id}/files`, 'winvitee')).status === 404);

// ---- delete ----
const member = (await list()).find((f) => f.path === 'member.md');
ok('delete removes the record, the bytes and the embeddings', (await api(`/files/${member.id}`, 'wowner', 'DELETE')).status === 204 && !existsSync(join(CLOUD, P.id, 'member.md')) && (await db.query('select 1 from memory_chunks where source_id=$1', [member.id])).rowCount === 0 && !(await list()).some((f) => f.id === member.id));

// ---- local folder ----
const dir = join(BASE, 'projA'); rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'src'), { recursive: true }); mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true }); mkdirSync(join(dir, '.git'), { recursive: true });
writeFileSync(join(dir, 'README.md'), '# Project A\nA tool that tracks warehouse inventory.'); writeFileSync(join(dir, 'src/main.py'), '# entry point\nprint("hello")');
writeFileSync(join(dir, 'node_modules/pkg/x.js'), 'vendored'); writeFileSync(join(dir, '.git/config'), 'secret'); writeFileSync(join(dir, '.hidden.txt'), 'hidden');
writeFileSync(join(dir, 'big.txt'), Buffer.alloc(6 * 1024 * 1024, 97)); writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
const outside = join(BASE, '..', `outside-${Date.now()}.txt`); writeFileSync(outside, 'TOP SECRET'); symlinkSync(outside, join(dir, 'link.txt'));
const folders = (await api(`/projects/${P.id}/workspace`, 'wowner')).body;
ok('owner sees the folders available under the base; others do not', folders.localEnabled && folders.localFolders.includes('projA') && (await api(`/projects/${P.id}/workspace`, 'wmember')).body.localFolders.length === 0, folders);
for (const bad of ['../..', '/etc', '..', 'a/b', '..%2f']) ok(`local folder "${bad}" is refused`, [400, 404].includes((await api(`/projects/${P.id}/workspace`, 'wowner', 'PUT', { localRoot: bad })).status));
ok('unknown folder 404', (await api(`/projects/${P.id}/workspace`, 'wowner', 'PUT', { localRoot: 'nope' })).status === 404);
ok('connect a folder', (await api(`/projects/${P.id}/workspace`, 'wowner', 'PUT', { localRoot: 'projA' })).status === 204);
const locals = (await list()).filter((f) => f.kind === 'local').map((f) => f.path).sort();
ok('scan indexes real files only (no vendor dirs, dotfiles, symlinks, oversize)', locals.join() === 'README.md,image.png,src/main.py', locals);
const readme = (await list()).find((f) => f.path === 'README.md');
ok('local text files are searchable', (await ctx('warehouse inventory tool')).files.some((h) => /warehouse inventory/.test(h.text)));
ok('uploading over a local path is refused', (await api(`/projects/${P.id}/files`, 'wowner', 'POST', undefined, form('', [['README.md', 'x']]))).body.rejected[0]?.reason?.includes('connected folder'));
ok('local files can be edited in place (written to disk)', (await api(`/files/${readme.id}`, 'wowner', 'PUT', { content: '# Project A\nNow tracks supplier invoices.' })).status === 200 && readFileSync(join(dir, 'README.md'), 'utf8').includes('supplier invoices'));
ok('local files cannot be deleted through the app', (await api(`/files/${readme.id}`, 'wowner', 'DELETE')).body?.error?.code === 'local_readonly_delete' && existsSync(join(dir, 'README.md')));
// a symlink swapped in after the scan must not be readable
await db.query("insert into workspace_files(project_id, path, kind, size, mime) values ($1,'link.txt','local',10,'text/plain')", [P.id]);
const esc = (await list()).find((f) => f.path === 'link.txt');
ok('files that resolve outside the folder are never read', (await api(`/files/${esc.id}`, 'wowner')).status === 400 && (await api(`/files/${esc.id}/raw`, 'wowner')).status === 400);
await db.query('delete from workspace_files where id = $1', [esc.id]);

// watcher
writeFileSync(join(dir, 'new-note.md'), '# Quarterly retrospective\nWhat went well.');
ok('watcher picks up new files', !!(await waitFor(async () => (await list()).some((f) => f.path === 'new-note.md' && f.summary === 'Quarterly retrospective'))));
ok('...and indexes them', (await ctx('quarterly retrospective what went well')).files.some((h) => /retrospective/.test(h.text)));
writeFileSync(join(dir, 'new-note.md'), '# Annual budget review\nNumbers.');
ok('watcher re-indexes edits', !!(await waitFor(async () => (await list()).some((f) => f.path === 'new-note.md' && f.summary === 'Annual budget review'))));
unlinkSync(join(dir, 'new-note.md'));
ok('watcher removes deleted files and their embeddings', !!(await waitFor(async () => !(await list()).some((f) => f.path === 'new-note.md'))) && !(await ctx('annual budget review numbers')).files.some((h) => /budget review/.test(h.text)));
const rescan = await api(`/projects/${P.id}/rescan`, 'wowner', 'POST');
ok('manual rescan reports counts', rescan.status === 200 && rescan.body.files === 3, rescan.body);
ok('disconnecting drops local entries but leaves disk files alone', (await api(`/projects/${P.id}/workspace`, 'wowner', 'PUT', { localRoot: null })).status === 204 && (await list()).every((f) => f.kind === 'cloud') && existsSync(join(dir, 'README.md')));

// project deletion
ok('deleting the project removes uploaded files from storage', (await api(`/projects/${P.id}`, 'wowner', 'DELETE')).status === 204 && !existsSync(join(CLOUD, P.id)) && existsSync(join(dir, 'README.md')));

rmSync(dir, { recursive: true, force: true }); rmSync(outside, { force: true });
for (const u of U) await api(`/users/${id(u)}`, u, 'DELETE');
await db.end();
process.exit(process.exitCode ?? 0);
