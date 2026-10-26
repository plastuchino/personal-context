import type pg from 'pg';
import { credentialCipher } from '@personal-context/security';
import { transaction } from './records.js';
export async function configureSlackSocket(pool:pg.Pool,accountId:string,appToken:string,key:string):Promise<boolean> {
 if(!/^xapp-[A-Za-z0-9-]+$/.test(appToken)||appToken.length>2048)throw new Error('Invalid app token format');
 const encrypted=credentialCipher(key).encrypt(appToken);
 return transaction(pool,async c=>{
  const state=await c.query('SELECT account_id FROM slack_connection_state WHERE account_id=$1 FOR UPDATE',[accountId]);
  if(!state.rowCount)return false;
  const id=(await c.query('INSERT INTO encrypted_credentials(ciphertext) VALUES($1) RETURNING id',[encrypted])).rows[0].id;
  await c.query("UPDATE slack_connection_state SET app_credential_ref=$2,status='disconnected',error_code=NULL,coverage_complete=false,gap_started_at=coalesce(gap_started_at,now()) WHERE account_id=$1",[accountId,id]);
  return true;
 });
}
export async function slackSocketStatus(pool:pg.Pool,accountIds:string[],status:string,code:string|null):Promise<void> {
 await pool.query(`UPDATE slack_connection_state SET status=$2,error_code=$3,
  connected_at=CASE WHEN $2='connected' THEN now() ELSE connected_at END,
  gap_started_at=CASE WHEN $2='connected' THEN gap_started_at ELSE coalesce(gap_started_at,now()) END,
  coverage_complete=CASE WHEN $2='connected' THEN coverage_complete ELSE false END WHERE account_id=ANY($1::uuid[])`,[accountIds,status,code]);
}
