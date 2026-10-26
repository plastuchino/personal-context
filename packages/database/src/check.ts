import { loadConfig } from '@personal-context/config';
import { createPool } from './index.js';

const pool = createPool(loadConfig());
try {
  const { rows } = await pool.query("SELECT current_database() AS database, extversion FROM pg_extension WHERE extname = 'vector'");
  if (!rows.length) throw new Error('pgvector extension is not installed');
  console.info('PostgreSQL and pgvector are available', rows[0]);
} finally { await pool.end(); }
