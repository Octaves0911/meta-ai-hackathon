import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SaveFileBody, WorkspaceSettingsBody, type WorkspaceFile, type WorkspaceInfo } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { MAX_TEXT_BYTES, isTextFile } from '../services/workspacePaths.js';
import type { FileRow } from '../workspace/service.js';
import { readFile } from 'node:fs/promises';

const toFile = (r: FileRow): WorkspaceFile => ({
  id: r.id, path: r.path, kind: r.kind, size: r.size, mime: r.mime, summary: r.summary, updatedAt: r.updated_at,
  textual: isTextFile(r.path) && (r.size ?? 0) <= MAX_TEXT_BYTES,
});
const uuid = (id: string) => { if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'not_found', 'not found'); return id; };
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

export async function workspaceRoutes(app: FastifyInstance) {
  const ws = () => app.workspace;

  app.get<{ Params: { id: string } }>('/projects/:id/workspace', async (req): Promise<WorkspaceInfo> => {
    const me = await requireUser(app, req);
    const p = await ws().access(uuid(req.params.id), me.id);
    const isOwner = p.owner_id === me.id;
    return {
      level: p.level, isOwner, shareWorkspace: p.share_workspace, localRoot: p.local_root,
      localEnabled: !!ws().localBase(), localFolders: isOwner ? ws().listLocalFolders() : [], maxUploadMb: Number(process.env.WORKSPACE_MAX_UPLOAD_MB ?? 50),
    };
  });

  app.put<{ Params: { id: string } }>('/projects/:id/workspace', async (req, reply) => {
    const me = await requireUser(app, req);
    const b = WorkspaceSettingsBody.parse(req.body);
    const p = await ws().project(uuid(req.params.id));
    const { rows } = await app.db.query('select 1 from project_members where project_id = $1 and user_id = $2', [p.id, me.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'project not found');
    if (p.owner_id !== me.id) throw new HttpError(403, 'forbidden', 'only the project owner can change workspace settings');
    if (b.shareWorkspace !== undefined) await app.db.query('update projects set share_workspace = $2 where id = $1', [p.id, b.shareWorkspace]);
    if (b.localRoot !== undefined) await ws().setLocalRoot(p.id, b.localRoot);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/projects/:id/files', async (req) => {
    const me = await requireUser(app, req);
    await ws().access(uuid(req.params.id), me.id);
    const { rows } = await app.db.query('select * from workspace_files where project_id = $1 order by path', [req.params.id]);
    return rows.map(toFile);
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/projects/:id/files/search', async (req) => {
    const me = await requireUser(app, req);
    const q = z.string().trim().min(1).max(200).parse(req.query.q);
    await ws().access(uuid(req.params.id), me.id);
    return (await ws().search(req.params.id, q)).map((r) => ({ ...toFile(r.file), snippet: r.snippet, score: r.score }));
  });

  app.get<{ Params: { id: string } }>('/files/:id', async (req) => {
    const me = await requireUser(app, req);
    const f = await ws().file(uuid(req.params.id));
    const p = await ws().access(f.project_id, me.id);
    const info = toFile(f);
    return { ...info, content: info.textual ? await ws().readText(f, p).catch((e) => { if (e instanceof HttpError && e.status === 415) return null; throw e; }) : null };
  });

  // Raw bytes for previews/downloads. Served with nosniff + a sandboxing CSP so uploaded content can never run in our origin.
  app.get<{ Params: { id: string } }>('/files/:id/raw', async (req, reply) => {
    const me = await requireUser(app, req);
    const f = await ws().file(uuid(req.params.id));
    const p = await ws().access(f.project_id, me.id);
    const buf = await readFile(ws().physical(f, p)).catch(() => { throw new HttpError(404, 'not_found', 'the file is no longer on disk'); });
    const mime = f.mime ?? 'application/octet-stream';
    return reply.header('content-type', INLINE.test(mime) ? mime : 'application/octet-stream').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', `${INLINE.test(mime) ? 'inline' : 'attachment'}; filename="${basename(f.path).replace(/["\r\n]/g, '_')}"`).send(buf);
  });

  app.put<{ Params: { id: string } }>('/files/:id', async (req) => {
    const me = await requireUser(app, req);
    const { content } = SaveFileBody.parse(req.body);
    const f = await ws().file(uuid(req.params.id));
    const p = await ws().access(f.project_id, me.id, 'write');
    await ws().saveText(f, p, content);
    return toFile(await ws().file(f.id));
  });

  // Multi-file upload into cloud storage. Each file is validated on its own; one bad file does not sink the rest.
  app.post<{ Params: { id: string } }>('/projects/:id/files', async (req, reply) => {
    const me = await requireUser(app, req);
    const project = await ws().access(uuid(req.params.id), me.id, 'write');
    if (!req.isMultipart()) throw new HttpError(400, 'invalid_request', 'send multipart/form-data');
    const uploaded: WorkspaceFile[] = [];
    const rejected: { name: string; reason: string }[] = [];
    let dir = '';
    for await (const part of req.parts()) {
      if (part.type === 'field') { if (part.fieldname === 'dir') dir = String(part.value ?? '').replace(/^\/+|\/+$/g, ''); continue; }
      const name = basename(part.filename.replace(/\\/g, '/'));
      const buf = await part.toBuffer().catch(() => null);
      if (!buf || part.file.truncated) { rejected.push({ name, reason: `larger than ${Number(process.env.WORKSPACE_MAX_UPLOAD_MB ?? 50)} MB` }); continue; }
      try { uploaded.push(toFile(await ws().upload(project, dir ? `${dir}/${name}` : name, buf))); }
      catch (e) { if (!(e instanceof HttpError)) app.log.error(e, 'upload failed'); rejected.push({ name, reason: e instanceof HttpError ? e.message : 'upload failed' }); }
    }
    return reply.status(uploaded.length ? 201 : 400).send({ uploaded, rejected });
  });

  app.post<{ Params: { id: string } }>('/projects/:id/rescan', async (req) => {
    const me = await requireUser(app, req);
    const p = await ws().access(uuid(req.params.id), me.id, 'write');
    if (!p.local_root) throw new HttpError(409, 'local_unavailable', 'no local folder is connected');
    return ws().scanLocal(p.id);
  });

  app.delete<{ Params: { id: string } }>('/files/:id', async (req, reply) => {
    const me = await requireUser(app, req);
    const f = await ws().file(uuid(req.params.id));
    const p = await ws().access(f.project_id, me.id, 'write');
    await ws().remove(f, p);
    return reply.status(204).send();
  });
}
