import { loadConfig } from '@personal-context/config';
import { hashPassword } from '@personal-context/security';
import { createPool } from './index.js';
let password=process.env.OWNER_PASSWORD;
if(!password) {
 if(!process.stdin.isTTY) throw new Error('Run interactively or set OWNER_PASSWORD for this setup command only');
 const {createInterface}=await import('node:readline/promises');
 const {Writable}=await import('node:stream');
 const silent=new Writable({write(_chunk,_encoding,done){done();}});
 const prompt=createInterface({input:process.stdin,output:silent,terminal:true});
 try {
  process.stdout.write('New owner password (12–1024 characters): ');
  password=await prompt.question('');
  process.stdout.write('\nConfirm password: ');
  const confirmation=await prompt.question('');
  process.stdout.write('\n');
  if(password!==confirmation) throw new Error('Passwords do not match');
 } finally {prompt.close();silent.end();}
}
const encoded=await hashPassword(password);
const pool=createPool(loadConfig());
try {
 // Resetting the password also invalidates all previous sessions atomically.
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('INSERT INTO owner_account(id,password_hash) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash',[encoded]);
  await client.query('DELETE FROM owner_sessions');
  await client.query('COMMIT');
 } catch(e) { await client.query('ROLLBACK');throw e; } finally { client.release(); }
 console.info('Owner password configured; existing sessions invalidated');
} finally {await pool.end();}
