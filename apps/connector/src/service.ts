import type pg from 'pg';
import { createEmbedder, toVector, type Embedder } from '@meetpilot/shared/embedder';
import * as google from './google.js';
import { parseMessage } from './gmailParse.js';
import { signState, verifyState } from './state.js';
import { buildRaw, MimeError } from './mime.js';
import { open, seal, vaultConfigured, type Tokens } from './vault.js';

export class ConnectorError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

type Provider = 'gmail' | 'drive';
const LOOKBACK = { min: 7, max: 365, def: 30 };
const MAX_FOLDERS = 50;
const EMBED_BATCH = 32;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface ConnectionView {
  id: string; provider: Provider; visibility: 'private' | 'project'; status: string; account: string | null;
  lastSyncAt: string | null; itemCount: number; ownerId: string; ownerName: string; isOwner: boolean; lastError: string | null;
  config: { labels: string[]; lookbackDays: number; folderIds: string[]; includeSubfolders: boolean };
}

/** Owns Google connections: OAuth, the encrypted token vault, sync into external_items, visibility and deletion. */
export class Connector {
  private syncing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private db: pg.Pool, private embedder: Embedder = createEmbedder()) {}

  startBackground(everyMs = Number(process.env.SYNC_INTERVAL_MS ?? 10 * 60_000)) {
    this.timer = setInterval(() => void this.syncAllDue().catch(() => {}), everyMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  private ensureReady() {
    if (!vaultConfigured()) throw new ConnectorError(503, 'not_configured', 'TOKEN_ENC_KEY is not configured');
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new ConnectorError(503, 'not_configured', 'Google OAuth credentials are not configured');
  }

  // ---- OAuth --------------------------------------------------------------------------------------------------
  start(a: { projectId: string; userId: string; services: Provider[]; visibility: 'private' | 'project'; sendAccess?: boolean; returnTo?: string }) {
    this.ensureReady();
    // Sending is a separate, explicit permission and only ever applies to Gmail; returnTo must be an in-app path.
    if (a.sendAccess && (a.services.length !== 1 || a.services[0] !== 'gmail')) throw new ConnectorError(400, 'invalid_request', 'send access applies to Gmail only');
    if (a.returnTo && !/^\/(?!\/)[\w\-./?=&%]*$/.test(a.returnTo)) throw new ConnectorError(400, 'invalid_request', 'invalid return path');
    return { url: google.authUrl(signState(a), a.services, !!a.sendAccess) };
  }

  async complete(code: string, stateToken: string): Promise<{ projectId: string; connectionIds: string[]; returnTo?: string }> {
    this.ensureReady();
    const state = verifyState(stateToken);
    if (!state) throw new ConnectorError(400, 'invalid_state', 'the sign-in link expired or is invalid');
    const { rowCount } = await this.db.query('select 1 from project_members where project_id = $1 and user_id = $2', [state.projectId, state.userId]);
    if (!rowCount) throw new ConnectorError(403, 'forbidden', 'not a member of this project');
    let tokens: Tokens;
    try { tokens = await google.exchangeCode(code); } catch { throw new ConnectorError(400, 'oauth_failed', 'Google did not accept the authorisation code'); }
    const account = await google.userEmail(tokens.access_token).catch(() => 'unknown');
    const ids: string[] = [];
    for (const provider of state.services) {
      const sealed = seal(tokens);
      const scopes = state.sendAccess ? [google.SCOPES.gmail, google.SEND_SCOPE] : [google.SCOPES[provider]];
      const { rows: ex } = await this.db.query('select id from connections where project_id = $1 and user_id = $2 and provider = $3', [state.projectId, state.userId, provider]);
      if (ex[0]) {
        await this.db.query(
          `update connections set visibility = $2, scopes = $3, status = case when $8::boolean then status else 'needs_setup' end, token_ciphertext = $4, token_iv = $5, token_tag = $6,
             config = jsonb_set(config, '{account}', to_jsonb($7::text)) - 'lastError' where id = $1`,
          [ex[0].id, state.sendAccess ? (await this.db.query('select visibility from connections where id = $1', [ex[0].id])).rows[0].visibility : state.visibility, scopes, sealed.ciphertext, sealed.iv, sealed.tag, account, !!state.sendAccess]);
        await this.db.query('update external_items set visibility = $2 where connection_id = $1', [ex[0].id, state.visibility]);
        ids.push(ex[0].id);
      } else {
        const { rows } = await this.db.query(
          `insert into connections(project_id, user_id, provider, visibility, config, scopes, status, token_ciphertext, token_iv, token_tag)
           values ($1,$2,$3,$4,$5,$6,'needs_setup',$7,$8,$9) returning id`,
          [state.projectId, state.userId, provider, state.visibility, { account }, scopes, sealed.ciphertext, sealed.iv, sealed.tag]);
        ids.push(rows[0].id);
      }
    }
    return { projectId: state.projectId, connectionIds: ids, returnTo: state.returnTo };
  }

  // ---- views --------------------------------------------------------------------------------------------------
  private view(r: any, viewerId: string): ConnectionView {
    const c = r.config ?? {};
    return {
      id: r.id, provider: r.provider, visibility: r.visibility, status: r.status, account: c.account ?? null,
      lastSyncAt: r.last_sync_at, itemCount: r.item_count ?? 0, ownerId: r.user_id, ownerName: r.owner_name, isOwner: r.user_id === viewerId,
      lastError: r.user_id === viewerId ? c.lastError ?? null : null,
      // others only see that a shared source exists, not how it is configured
      config: r.user_id === viewerId ? { labels: c.labels ?? [], lookbackDays: c.lookbackDays ?? LOOKBACK.def, folderIds: c.folderIds ?? [], includeSubfolders: !!c.includeSubfolders }
        : { labels: [], lookbackDays: LOOKBACK.def, folderIds: [], includeSubfolders: false },
    };
  }

  async list(projectId: string, viewerId: string): Promise<ConnectionView[]> {
    const { rows } = await this.db.query(
      `select c.id, c.user_id, c.provider, c.visibility, c.status, c.config, c.last_sync_at, u.username as owner_name,
              (select count(*)::int from external_items i where i.connection_id = c.id) as item_count
       from connections c join users u on u.id = c.user_id
       where c.project_id = $1 and (c.user_id = $2 or c.visibility = 'project') order by c.created_at`, [projectId, viewerId]);
    return rows.map((r) => this.view(r, viewerId));
  }

  private async owned(id: string, userId: string) {
    const { rows } = await this.db.query('select * from connections where id = $1', [id]);
    if (!rows[0] || rows[0].user_id !== userId) throw new ConnectorError(404, 'not_found', 'connection not found'); // do not reveal others' connections
    return rows[0];
  }

  // ---- tokens -------------------------------------------------------------------------------------------------
  private async accessToken(c: any): Promise<string> {
    if (!c.token_ciphertext) throw new ConnectorError(409, 'no_token', 'reconnect Google');
    let t: Tokens;
    try { t = open({ ciphertext: c.token_ciphertext, iv: c.token_iv, tag: c.token_tag }); }
    catch { // wrong/rotated TOKEN_ENC_KEY or tampered row: never crash, ask the user to reconnect
      await this.setError(c.id, 'Stored Google access could not be read — reconnect to continue syncing.');
      throw new ConnectorError(409, 'reauth_required', 'reconnect Google');
    }
    if (t.expires_at - Date.now() < 60_000) {
      try { t = await google.refresh(t); }
      catch (e) {
        await this.setError(c.id, e instanceof google.GoogleError && e.code === 'invalid_grant' ? 'Google access was revoked — reconnect to continue syncing.' : 'Could not refresh Google access.');
        throw new ConnectorError(409, 'reauth_required', 'reconnect Google');
      }
      const s = seal(t);
      await this.db.query('update connections set token_ciphertext = $2, token_iv = $3, token_tag = $4 where id = $1', [c.id, s.ciphertext, s.iv, s.tag]);
    }
    return t.access_token;
  }
  private setError(id: string, msg: string) {
    return this.db.query(`update connections set status = 'error', config = jsonb_set(config, '{lastError}', to_jsonb($2::text)) where id = $1`, [id, msg]);
  }

  // ---- settings -----------------------------------------------------------------------------------------------
  async update(id: string, userId: string, p: { visibility?: 'private' | 'project'; confirmShare?: boolean; labels?: string[]; lookbackDays?: number; folderIds?: string[]; includeSubfolders?: boolean }) {
    const c = await this.owned(id, userId);
    if (p.visibility === 'project' && c.visibility !== 'project' && p.confirmShare !== true) {
      throw new ConnectorError(400, 'confirmation_required', 'sharing with the project needs explicit confirmation');
    }
    const cfg = { ...c.config };
    if (p.labels) cfg.labels = p.labels.slice(0, 50);
    if (p.lookbackDays !== undefined) cfg.lookbackDays = clamp(Math.round(p.lookbackDays), LOOKBACK.min, LOOKBACK.max);
    if (p.folderIds) cfg.folderIds = p.folderIds.slice(0, MAX_FOLDERS);
    if (p.includeSubfolders !== undefined) cfg.includeSubfolders = p.includeSubfolders;
    const configured = c.provider === 'gmail' ? (cfg.labels ?? []).length > 0 : (cfg.folderIds ?? []).length > 0;
    const vis = p.visibility ?? c.visibility;
    const cl = await this.db.connect();
    try {
      await cl.query('begin');
      await cl.query('update connections set visibility = $2, config = $3, status = $4 where id = $1', [id, vis, cfg, configured ? (c.status === 'needs_setup' || c.status === 'error' ? 'connected' : c.status) : 'needs_setup']);
      await cl.query('update external_items set visibility = $2 where connection_id = $1', [id, vis]); // stored items follow the new audience immediately
      await cl.query('commit');
    } catch (e) { await cl.query('rollback'); throw e; } finally { cl.release(); }
    if (configured && (p.labels || p.folderIds || p.lookbackDays !== undefined || p.includeSubfolders !== undefined)) void this.sync(id).catch(() => {});
  }

  async gmailLabels(id: string, userId: string) {
    const c = await this.owned(id, userId);
    if (c.provider !== 'gmail') throw new ConnectorError(400, 'invalid_request', 'not a Gmail connection');
    const labels = await google.gmail.labels(await this.accessToken(c));
    return labels.map((l) => ({ id: l.id, name: l.name, system: l.type === 'system' }));
  }

  async driveFolders(id: string, userId: string, parent: string) {
    const c = await this.owned(id, userId);
    if (c.provider !== 'drive') throw new ConnectorError(400, 'invalid_request', 'not a Drive connection');
    const files = await google.drive.list(await this.accessToken(c), parent || 'root');
    return files.filter((f) => f.mimeType === google.FOLDER_MIME).map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- sync ---------------------------------------------------------------------------------------------------
  async syncAllDue() {
    const { rows } = await this.db.query("select id from connections where status in ('connected', 'error') and token_ciphertext is not null");
    for (const r of rows) await this.sync(r.id).catch(() => {});
  }

  async sync(id: string, userId?: string): Promise<void> {
    const c = userId ? await this.owned(id, userId) : (await this.db.query('select * from connections where id = $1', [id])).rows[0];
    if (!c) return;
    if (this.syncing.has(id)) return;
    const cfg = c.config ?? {};
    const configured = c.provider === 'gmail' ? (cfg.labels ?? []).length > 0 : (cfg.folderIds ?? []).length > 0;
    if (!configured) return; // nothing is read until the user chooses what to sync (F9.1)
    this.syncing.add(id);
    await this.db.query("update connections set status = 'syncing' where id = $1", [id]);
    try {
      const token = await this.accessToken(c);
      const docs = c.provider === 'gmail' ? await this.collectGmail(c, token) : await this.collectDrive(c, token);
      await this.store(c, docs.items, docs.seen);
      await this.db.query(`update connections set status = 'connected', last_sync_at = now(), config = config - 'lastError' where id = $1`, [id]);
    } catch (e) {
      if (!(e instanceof ConnectorError)) await this.setError(id, 'Sync failed — will retry.');
      throw e;
    } finally {
      this.syncing.delete(id);
    }
  }

  private async existing(connectionId: string): Promise<Map<string, string | null>> {
    const { rows } = await this.db.query('select external_id, occurred_at from external_items where connection_id = $1', [connectionId]);
    return new Map(rows.map((r) => [r.external_id, r.occurred_at ? new Date(r.occurred_at).toISOString() : null]));
  }

  private async collectGmail(c: any, token: string) {
    const days = clamp(c.config.lookbackDays ?? LOOKBACK.def, LOOKBACK.min, LOOKBACK.max);
    const ids = await google.gmail.listIds(token, c.config.labels, days);
    const have = await this.existing(c.id);
    const items: Doc[] = [];
    for (const id of ids.filter((i) => !have.has(i))) { // mail is immutable: fetch only what is new
      const m = parseMessage(await google.gmail.get(token, id));
      if (m.text) items.push({ externalId: id, title: m.subject, author: m.author, url: `https://mail.google.com/mail/u/0/#all/${id}`, occurredAt: m.date, text: m.text,
        meta: { fromEmail: m.fromEmail, messageId: m.messageId, threadId: m.threadId, subject: m.subject } });
    }
    return { items, seen: ids };
  }

  private async collectDrive(c: any, token: string) {
    const roots: string[] = c.config.folderIds;
    const folders = new Set(roots);
    const queue = [...roots];
    const files = new Map<string, google.DriveFile>();
    for (let i = 0; i < queue.length && i < MAX_FOLDERS; i++) {
      for (const f of await google.drive.list(token, queue[i])) {
        if (f.mimeType === google.FOLDER_MIME) { if (c.config.includeSubfolders && !folders.has(f.id) && folders.size < MAX_FOLDERS) { folders.add(f.id); queue.push(f.id); } }
        else if (google.indexable(f)) files.set(f.id, f);
      }
    }
    const have = await this.existing(c.id);
    const items: Doc[] = [];
    for (const f of files.values()) {
      if (have.get(f.id) === new Date(f.modifiedTime).toISOString()) continue; // unchanged
      const text = (await google.drive.text(token, f)).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
      if (text) items.push({ externalId: f.id, title: f.name, author: c.config.account ?? null, url: f.webViewLink ?? null, occurredAt: new Date(f.modifiedTime), text });
    }
    return { items, seen: [...files.keys()] };
  }

  /** Embed and upsert new/changed items; remove anything no longer in scope (deleted, trashed, out of window, label removed). */
  private async store(c: any, items: Doc[], seen: string[]) {
    for (let i = 0; i < items.length; i += EMBED_BATCH) {
      const batch = items.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch.map((d) => `${d.title}\n${d.text}`.slice(0, 2000)));
      for (let j = 0; j < batch.length; j++) {
        const d = batch[j];
        await this.db.query(
          `insert into external_items(connection_id, project_id, owner_id, provider, external_id, title, author, url, visibility, occurred_at, text, embedding, meta)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector,$13)
           on conflict (connection_id, external_id) do update set title = excluded.title, author = excluded.author, url = excluded.url,
             visibility = excluded.visibility, occurred_at = excluded.occurred_at, text = excluded.text, embedding = excluded.embedding, meta = excluded.meta`,
          [c.id, c.project_id, c.user_id, c.provider, d.externalId, d.title, d.author, d.url, c.visibility, d.occurredAt, d.text, toVector(vectors[j]), d.meta ?? {}]);
      }
    }
    await this.db.query('delete from external_items where connection_id = $1 and not (external_id = any($2::text[]))', [c.id, seen]);
  }

  // ---- sending -------------------------------------------------------------------------------------------------
  /** Does this user have a Gmail connection with permission to send? */
  async sendAccess(projectId: string, userId: string): Promise<{ granted: boolean; account: string | null }> {
    const { rows } = await this.db.query("select config from connections where project_id = $1 and user_id = $2 and provider = 'gmail' and $3 = any(scopes) and token_ciphertext is not null", [projectId, userId, google.SEND_SCOPE]);
    return { granted: !!rows[0], account: rows[0]?.config?.account ?? null };
  }

  /** Send one approved email as the user. The caller (backend) has already checked approval, confirmation and duplicates. */
  async sendMail(a: { projectId: string; userId: string; to: string[]; cc?: string[]; subject: string; body: string; threadId?: string | null; inReplyTo?: string | null; references?: string | null }) {
    this.ensureReady();
    const { rows } = await this.db.query("select * from connections where project_id = $1 and user_id = $2 and provider = 'gmail' and $3 = any(scopes) and token_ciphertext is not null", [a.projectId, a.userId, google.SEND_SCOPE]);
    const c = rows[0];
    if (!c) throw new ConnectorError(409, 'send_permission_required', 'allow MeetPilot to send email from your Gmail first');
    let raw: string;
    try { raw = buildRaw({ from: c.config.account, to: a.to, cc: a.cc, subject: a.subject, body: a.body, inReplyTo: a.inReplyTo, references: a.references }); }
    catch (e) { if (e instanceof MimeError) throw new ConnectorError(400, 'invalid_email', e.message); throw e; }
    try {
      const sent = await google.sendMessage(await this.accessToken(c), raw, a.threadId);
      return { messageId: sent.id, threadId: sent.threadId ?? a.threadId ?? null, from: c.config.account as string };
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      if (e instanceof google.GoogleError && (e.status === 401 || e.status === 403)) throw new ConnectorError(409, 'send_permission_required', 'Google refused to send; allow sending again');
      throw new ConnectorError(502, 'send_failed', 'Gmail could not send the message');
    }
  }

  // ---- deletion -----------------------------------------------------------------------------------------------
  /** Revoke at Google, then delete the connection, its tokens and every indexed item (F9.7). */
  async disconnect(id: string, userId: string) {
    const c = await this.owned(id, userId);
    await this.purge([c]);
  }
  async purgeProject(projectId: string) { await this.purge((await this.db.query('select * from connections where project_id = $1', [projectId])).rows); }
  async purgeUser(userId: string) { await this.purge((await this.db.query('select * from connections where user_id = $1', [userId])).rows); }

  private async purge(conns: any[]) {
    for (const c of conns) {
      if (c.token_ciphertext && vaultConfigured()) { try { await google.revoke(open({ ciphertext: c.token_ciphertext, iv: c.token_iv, tag: c.token_tag })); } catch { /* unreadable token: still delete our copy */ } }
      await this.db.query('delete from connections where id = $1', [c.id]); // external_items cascade
    }
  }
}

interface Doc { externalId: string; title: string; author: string | null; url: string | null; occurredAt: Date | null; text: string; meta?: Record<string, string | null> }
