import type { Pool } from 'pg';

export type JobHandler = (payload: any) => Promise<void>;
const MAX_ATTEMPTS = 3;

export const enqueue = (db: Pool, kind: string, payload: object, delayMs = 0) =>
  db.query("insert into jobs(kind, payload, run_at) values ($1,$2, now() + ($3 || ' milliseconds')::interval)", [kind, payload, String(delayMs)]);

/** At-least-once job worker backed by the jobs table (docs/01 §3). Safe with several workers via SKIP LOCKED. */
export class JobRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private db: Pool, private handlers: Record<string, JobHandler>, private log: { error: (...a: any[]) => void },
    private onGiveUp: (kind: string, payload: any, error: string) => Promise<void> = async () => {}) {}

  start(tickMs = Number(process.env.JOBS_TICK_MS ?? 2000)) { this.timer = setInterval(() => void this.drain(), tickMs); }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Run due jobs until none are left (serialised per runner). */
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const { rows } = await this.db.query(
          `update jobs set status = 'running', attempts = attempts + 1 where id = (
             select id from jobs where status = 'pending' and run_at <= now() order by run_at limit 1 for update skip locked)
           returning id, kind, payload, attempts`);
        const job = rows[0];
        if (!job) return;
        try {
          const h = this.handlers[job.kind];
          if (!h) throw new Error(`no handler for ${job.kind}`);
          await h(job.payload);
          await this.db.query("update jobs set status = 'done' where id = $1", [job.id]);
        } catch (e) {
          const msg = (e as Error).message;
          this.log.error(e, `job ${job.kind} failed (attempt ${job.attempts})`);
          if (job.attempts >= MAX_ATTEMPTS) {
            await this.db.query("update jobs set status = 'failed', last_error = $2 where id = $1", [job.id, msg]);
            await this.onGiveUp(job.kind, job.payload, msg).catch((err) => this.log.error(err));
          } else {
            await this.db.query("update jobs set status = 'pending', last_error = $2, run_at = now() + ($3 || ' seconds')::interval where id = $1", [job.id, msg, String(2 ** job.attempts)]);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
