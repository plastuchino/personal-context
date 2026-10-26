import type pg from 'pg';
import { token,digest,credentialCipher } from '@personal-context/security';

export async function storeCredential(pool:pg.Pool,accountId:string,plaintext:string,key:string):Promise<void> {
 const ciphertext=credentialCipher(key).encrypt(plaintext);
 const c=await pool.connect();
 try {
  await c.query('BEGIN');
  if(!(await c.query('SELECT 1 FROM source_accounts WHERE id=$1 FOR UPDATE',[accountId])).rowCount) throw new Error('Source account not found');
  const id=(await c.query('INSERT INTO encrypted_credentials(ciphertext) VALUES($1) RETURNING id',[ciphertext])).rows[0].id;
  await c.query('UPDATE source_accounts SET credential_ref=$2 WHERE id=$1',[accountId,id]);
  await c.query('COMMIT');
 } catch(error) {await c.query('ROLLBACK');throw error;} finally {c.release();}
}
export async function readCredential(pool:pg.Pool,accountId:string,key:string):Promise<string> {
 const row=(await pool.query('SELECT e.ciphertext FROM encrypted_credentials e JOIN source_accounts a ON a.credential_ref=e.id WHERE a.id=$1',[accountId])).rows[0];
 if(!row) throw new Error('Source credentials unavailable');
 return credentialCipher(key).decrypt(row.ciphertext);
}
export async function createOAuthState(pool:pg.Pool,sessionDigest:string,provider:string):Promise<string> {
 const state=token();
 await pool.query("INSERT INTO oauth_states(digest,session_digest,provider,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[digest(state),sessionDigest,provider]);
 return state;
}
export async function consumeOAuthState(pool:pg.Pool,state:string,sessionDigest:string,provider:string):Promise<void> {
 if(!state || !sessionDigest || !(await pool.query('DELETE FROM oauth_states WHERE digest=$1 AND session_digest=$2 AND provider=$3 AND expires_at>now() RETURNING digest',[digest(state),sessionDigest,provider])).rowCount) throw new Error('Invalid or expired OAuth state');
}
