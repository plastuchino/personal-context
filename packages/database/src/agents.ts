import type pg from 'pg';
import { digest,token } from '@personal-context/security';
import { transaction } from './records.js';

export async function issueAgent(pool:pg.Pool,name:string,accounts:string[]):Promise<{id:string;credential:string}> {
 if(!name.trim()||name.length>200||!accounts.length||accounts.length>100) throw new Error('Agent name and explicit source grants are required');
 const credential=token();
 const id=await transaction(pool,async c=>{
  const id=(await c.query('INSERT INTO agent_clients(name,credential_digest) VALUES($1,$2) RETURNING id',[name,digest(credential)])).rows[0].id;
  for(const account of new Set(accounts)) await c.query('INSERT INTO access_grants(client_id,account_id) VALUES($1,$2)',[id,account]);
  return id;
 });
 return {id,credential};
}
export async function authenticateAgent(pool:pg.Pool,credential:string):Promise<string|null> {
 if(!/^[A-Za-z0-9_-]{43}$/.test(credential))return null;
 return (await pool.query('SELECT id FROM agent_clients WHERE credential_digest=$1 AND revoked_at IS NULL',[digest(credential)])).rows[0]?.id ?? null;
}
export async function revokeAgent(pool:pg.Pool,id:string):Promise<void> {
 await pool.query('UPDATE agent_clients SET revoked_at=now() WHERE id=$1',[id]);
}
export async function agentRead<T>(pool:pg.Pool,clientId:string,run:(c:pg.PoolClient)=>Promise<T>):Promise<T> {
 return transaction(pool,async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  await c.query('SET LOCAL ROLE personal_context_reader');
  await c.query("SELECT set_config('app.client_id',$1,true)",[clientId]);
  return run(c);
 });
}
export async function auditRetrieval(pool:pg.Pool,clientId:string|null,tool:string,decision:string,records:string[]):Promise<void> {
 await transaction(pool,async c=>{
  await c.query('SET LOCAL ROLE personal_context_audit');
  await c.query('INSERT INTO retrieval_audit(client_id,tool,access_decision,returned_record_ids) VALUES($1,$2,$3,$4)',[clientId,tool,decision,records]);
 });
}
