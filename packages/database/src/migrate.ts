import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadConfig } from '@personal-context/config';
import { createPool } from './index.js';

export async function migrate(pool: pg.Pool): Promise<void> {
 const client = await pool.connect();
 try {
  await client.query('SELECT pg_advisory_lock(8463901)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) {
   if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
   const sql = await readFile(new URL(name, directory), 'utf8');
   await client.query('BEGIN');
   try { await client.query(sql); await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]); await client.query('COMMIT'); }
   catch (error) { await client.query('ROLLBACK'); throw error; }
  }
 } finally { await client.query('SELECT pg_advisory_unlock(8463901)'); client.release(); }
}
if (process.argv[1]?.endsWith('/migrate.ts')) {
 const pool = createPool(loadConfig());
 try { await migrate(pool); console.info('Migrations applied'); } finally { await pool.end(); }
}
