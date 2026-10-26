import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig } from '@personal-context/config';
import { createPool } from './index.js';

const config = loadConfig();
const pool = createPool(config);
const name = 'personal_context_test_' + randomUUID().replaceAll('-', '');
const url = new URL(config.databaseUrl); url.pathname = '/' + name;
let created = false;
try {
 await pool.query(`CREATE DATABASE "${name}"`); created = true;
 const code = await new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/database.test.ts', 'tests/slack-database.test.ts', 'tests/financial-database.test.ts', 'tests/ingestion-database.test.ts', 'tests/photos-database.test.ts', 'tests/classification-database.test.ts', 'tests/indexing-database.test.ts', 'tests/retrieval-database.test.ts', 'tests/mcp-database.test.ts', 'tests/restore-database.test.ts'], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url.toString() } });
  child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
 });
 process.exitCode = code;
} finally {
 if(created) await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
 await pool.end();
}
