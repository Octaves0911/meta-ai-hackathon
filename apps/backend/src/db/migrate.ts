// Minimal SQL migration runner: migrations/NNN_name.up.sql + NNN_name.down.sql.
// Usage: migrate.ts up | down [all] | status
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const names = [...new Set(readdirSync(dir).filter((f) => f.endsWith('.up.sql')).map((f) => f.replace('.up.sql', '')))].sort();

const [cmd = 'status', arg] = process.argv.slice(2);
const pool = createPool();
const client = await pool.connect();

try {
  await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name as string));

  const run = async (name: string, direction: 'up' | 'down') => {
    const sql = readFileSync(join(dir, `${name}.${direction}.sql`), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      if (direction === 'up') await client.query('insert into schema_migrations(name) values ($1)', [name]);
      else await client.query('delete from schema_migrations where name = $1', [name]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`${direction} ${name} failed: ${(e as Error).message}`);
    }
    console.log(`${direction} ${name}`);
  };

  if (cmd === 'up') {
    for (const n of names.filter((n) => !applied.has(n))) await run(n, 'up');
  } else if (cmd === 'down') {
    const todo = names.filter((n) => applied.has(n)).reverse();
    for (const n of arg === 'all' ? todo : todo.slice(0, 1)) await run(n, 'down');
  } else {
    for (const n of names) console.log(`${applied.has(n) ? '[x]' : '[ ]'} ${n}`);
  }
} finally {
  client.release();
  await pool.end();
}
