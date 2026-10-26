import pg from 'pg';
import type { Config } from '@personal-context/config';

export function createPool(config: Pick<Config, 'databaseUrl'>): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
}
