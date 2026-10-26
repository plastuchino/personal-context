import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, upsertRecord, type SourceRecord } from './records.js';

export interface Job { id: string; account_id: string; stream_key: string; stage: string; payload: unknown; lease_token: string; attempt: number; max_attempts: number }
export async function schedule(pool: pg.Pool, providers: string[] | null = null): Promise<number> {
 return transaction(pool,async c=>{
  const due = await c.query(`SELECT s.account_id,s.stream_key FROM sync_state s JOIN source_accounts a ON a.id=s.account_id
   WHERE s.enabled AND a.status='active' AND a.provider<>'google-photos' AND s.next_check_at<=now() AND ($1::text[] IS NULL OR a.provider=ANY($1)) FOR UPDATE OF s SKIP LOCKED`,[providers]);
  for(const s of due.rows) {
   await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key) VALUES($1,$2,'ingest',$3) ON CONFLICT DO NOTHING`,[s.account_id,s.stream_key,`ingest:${s.account_id}:${s.stream_key}`]);
   await c.query("UPDATE sync_state SET next_check_at=now()+interval '15 minutes' WHERE account_id=$1 AND stream_key=$2",[s.account_id,s.stream_key]);
  }
  return due.rowCount ?? 0;
 });
}
export async function claim(pool: pg.Pool, leaseSeconds=120, filter: {accountId?:string;stages?:string[]} = {}): Promise<Job | null> {
 if(!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>3600) throw new Error('Invalid lease duration');
 return transaction(pool,async c=>{
  // Stream rows serialize recovery and claims; a database constraint additionally
  // prevents two running jobs from owning the same stream.
  const streams = await c.query(`SELECT s.account_id,s.stream_key FROM sync_state s WHERE EXISTS(
   SELECT 1 FROM sync_jobs j WHERE j.account_id=s.account_id AND j.stream_key=s.stream_key
   AND ($1::uuid IS NULL OR s.account_id=$1) AND ($2::text[] IS NULL OR j.stage=ANY($2)) AND ((j.status='queued' AND j.scheduled_at<=now()) OR (j.status='running' AND j.lease_until<now())))
   AND NOT EXISTS(SELECT 1 FROM sync_jobs live WHERE live.account_id=s.account_id AND live.stream_key=s.stream_key AND live.status='running' AND live.lease_until>=now())
   ORDER BY s.account_id,s.stream_key FOR UPDATE OF s SKIP LOCKED LIMIT 1`,[filter.accountId??null,filter.stages??null]);
  if(!streams.rows.length) return null;
  const s=streams.rows[0];
  await c.query(`UPDATE sync_jobs SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'queued' END,
   lease_token=NULL,lease_until=NULL,error_code='lease_expired',finished_at=CASE WHEN attempt>=max_attempts THEN now() ELSE NULL END
   WHERE account_id=$1 AND stream_key=$2 AND status='running' AND lease_until<now()`,[s.account_id,s.stream_key]);
  if((await c.query("SELECT 1 FROM sync_jobs WHERE account_id=$1 AND stream_key=$2 AND status='running'",[s.account_id,s.stream_key])).rowCount) return null;
  const job=await c.query(`UPDATE sync_jobs SET status='running',attempt=attempt+1,lease_token=$3,lease_until=now()+make_interval(secs=>$4),started_at=now()
   WHERE id=(SELECT id FROM sync_jobs WHERE account_id=$1 AND stream_key=$2 AND status='queued' AND scheduled_at<=now() AND ($5::text[] IS NULL OR stage=ANY($5)) ORDER BY scheduled_at,id LIMIT 1) RETURNING *`,[s.account_id,s.stream_key,randomUUID(),leaseSeconds,filter.stages??null]);
  if(job.rows[0]?.stage==='ingest') await c.query('UPDATE sync_state SET last_attempt_at=now() WHERE account_id=$1 AND stream_key=$2',[s.account_id,s.stream_key]);
  return job.rows[0] ?? null;
 });
}
export async function fence(c:pg.PoolClient, job:Job):Promise<void> {
 const valid=await c.query("SELECT 1 FROM sync_jobs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",[job.id,job.lease_token]);
 if(!valid.rowCount) throw new Error('Job lease is no longer owned');
}
export async function heartbeat(pool:pg.Pool,job:Job):Promise<boolean> {
 return !!(await pool.query("UPDATE sync_jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()",[job.id,job.lease_token])).rowCount;
}
export async function commitPage(pool:pg.Pool,job:Job,page:{records:SourceRecord[];cursor:unknown;watermark?:string;complete:boolean;reset?:boolean;coverageStart?:string;coverageEnd?:string;coverageComplete?:boolean}):Promise<void> {
 await transaction(pool,async c=>{
  await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);
  await fence(c,job);
  for(const source of page.records) {
   if(source.accountId!==job.account_id) throw new Error('Page account does not match job');
   const stored=await upsertRecord(c,source);
   if(stored.changed&&source.slack)await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'reclassify',$3,$4) ON CONFLICT DO NOTHING`,[job.account_id,job.stream_key,`slack-context:${stored.recordId}:${source.slack.version??source.slack.messageTs}`,{recordId:stored.recordId,channelId:source.slack.channelId}]);
   if(stored.changed&&!source.deleted&&stored.revisionId)await queueDerived(c,job.account_id,stored.recordId,stored.revisionId);
  }
  if(page.reset)await c.query('UPDATE sync_state SET coverage_gap_at=coalesce(coverage_gap_at,now()),coverage_complete=false WHERE account_id=$1 AND stream_key=$2',[job.account_id,job.stream_key]);
  if(page.coverageStart)await c.query(`UPDATE sync_state SET coverage_start=$3,coverage_end=$4,coverage_complete=($5 AND coverage_gap_at IS NULL) WHERE account_id=$1 AND stream_key=$2`,[job.account_id,job.stream_key,page.coverageStart,page.coverageEnd??null,page.coverageComplete??false]);
  await c.query(`UPDATE sync_state SET cursor=$3,source_watermark_at=CASE WHEN $4::timestamptz IS NULL THEN source_watermark_at ELSE greatest(source_watermark_at,$4::timestamptz) END,
   last_success_at=CASE WHEN $5 THEN now() ELSE last_success_at END WHERE account_id=$1 AND stream_key=$2`,[job.account_id,job.stream_key,JSON.stringify(page.cursor),page.watermark ?? null,page.complete]);
  if(page.complete) await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
 });
}
export async function failJob(pool:pg.Pool,job:Job,code:string,retryAfterSeconds?:number):Promise<void> {
 if(!/^[a-z0-9_]{1,80}$/.test(code)) throw new Error('Use a redacted error code');
 if(retryAfterSeconds!==undefined && (!Number.isFinite(retryAfterSeconds)||retryAfterSeconds<0)) throw new Error('Invalid retry delay');
 await transaction(pool,async c=>{
  await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);
  await fence(c,job);
  const retry=job.attempt<job.max_attempts;
  const delay=Math.max(retryAfterSeconds ?? 0,Math.min(3600,2**job.attempt*5));
  await c.query(`UPDATE sync_jobs SET status=$2,error_code=$3,scheduled_at=now()+make_interval(secs=>$4),lease_token=NULL,lease_until=NULL,
   finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1`,[job.id,retry?'queued':'failed',code,delay]);
  if(job.stage==='slack-event')await c.query(`UPDATE slack_event_inbox SET status=$3,error_code=$4 WHERE id=$1 AND account_id=$2`,[(job.payload as {inboxId:string}).inboxId,job.account_id,retry?'queued':'failed',code]);
 });
}
export async function retryJob(pool:pg.Pool,id:string):Promise<boolean> {
 return transaction(pool,async c=>{
  const result=await c.query(`SELECT s.account_id,s.stream_key,j.dedupe_key,j.stage,j.payload FROM sync_state s JOIN sync_jobs j USING(account_id,stream_key) WHERE j.id=$1 AND j.status='failed' FOR UPDATE OF s,j`,[id]);
  if(!result.rows.length) return false;
  const j=result.rows[0];
  if((await c.query("SELECT 1 FROM sync_jobs WHERE account_id=$1 AND stream_key=$2 AND status IN ('queued','running')",[j.account_id,j.stream_key])).rowCount) return false;
  if(j.stage==='photo'){
   const p=j.payload as {sessionId:string;recordId?:string;action:string;item?:{type?:string}};
   const session=(await c.query('SELECT expires_at,polling_deadline_at FROM photo_import_sessions WHERE id=$1 AND account_id=$2 FOR UPDATE',[p.sessionId,j.account_id])).rows[0];
   if(!session)return false;
   if(p.action!=='analyze'&&!(p.action==='download'&&p.item?.type==='VIDEO')&&(session.expires_at.getTime()<=Date.now()||(p.action==='poll'&&session.polling_deadline_at?.getTime()<=Date.now()))){
    await c.query("UPDATE photo_import_sessions SET status='expired',error_code='photo_selection_expired' WHERE id=$1",[p.sessionId]);return false;
   }
   await c.query("UPDATE photo_import_sessions SET status=$2,error_code=NULL WHERE id=$1",[p.sessionId,p.action==='poll'?'selecting':'importing']);
   if(p.recordId)await c.query('UPDATE photo_import_items SET status=$3,error_code=NULL WHERE session_id=$1 AND record_id=$2',[p.sessionId,p.recordId,p.action==='analyze'?'downloaded':'queued']);
  }
  await c.query("UPDATE sync_jobs SET status='queued',attempt=0,scheduled_at=now(),finished_at=NULL,error_code=NULL WHERE id=$1",[id]);
  await c.query(`UPDATE slack_event_inbox SET status='queued',error_code=NULL WHERE id=(SELECT (payload->>'inboxId')::uuid FROM sync_jobs WHERE id=$1 AND stage='slack-event')`,[id]);
  return true;
 });
}

export async function queueDerived(db:pg.PoolClient,accountId:string,recordId:string,revisionId:string,suffix=''):Promise<void> {
 const stream=`derived:${recordId}`;
 await db.query('INSERT INTO sync_state(account_id,stream_key,enabled) VALUES($1,$2,false) ON CONFLICT DO NOTHING',[accountId,stream]);
 for(const stage of ['classify','embed'])await db.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[accountId,stream,stage,`${stage}:${revisionId}${suffix}`,{recordId,revisionId}]);
}
