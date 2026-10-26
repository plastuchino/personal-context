import type pg from 'pg';
import {transaction} from './records.js';
// Requeue previous missing-configuration failures when vision becomes available.
// These are existing distinct jobs, never duplicate executions; leases serialize each stream.
export async function resumeConfiguredPhotoAnalysis(pool:pg.Pool,accountId?:string):Promise<number> {
 return transaction(pool,async db=>{
  const streams=(await db.query(`SELECT s.account_id,s.stream_key FROM sync_state s WHERE ($1::uuid IS NULL OR s.account_id=$1)
   AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.account_id=s.account_id AND j.stream_key=s.stream_key AND j.stage='photo' AND j.status='failed' AND j.error_code='photo_model_unconfigured' AND j.payload->>'action'='analyze')
   ORDER BY s.account_id,s.stream_key FOR UPDATE OF s SKIP LOCKED LIMIT 100`,[accountId??null])).rows;
  let resumed=0;
  for(const stream of streams){
   const jobs=(await db.query(`SELECT DISTINCT ON(j.dedupe_key) j.id,j.payload FROM sync_jobs j
    WHERE j.account_id=$1 AND j.stream_key=$2 AND j.stage='photo' AND j.status='failed' AND j.error_code='photo_model_unconfigured' AND j.payload->>'action'='analyze'
    AND NOT EXISTS(SELECT 1 FROM sync_jobs live WHERE live.dedupe_key=j.dedupe_key AND live.status IN ('queued','running'))
    ORDER BY j.dedupe_key,j.scheduled_at DESC,j.id LIMIT 1000`,[stream.account_id,stream.stream_key])).rows;
   for(const job of jobs){
    await db.query("UPDATE sync_jobs SET status='queued',attempt=0,scheduled_at=now(),finished_at=NULL,error_code=NULL WHERE id=$1",[job.id]);
    await db.query("UPDATE photo_import_items SET status='downloaded',error_code=NULL WHERE session_id=$1 AND record_id=$2 AND media_asset_id IS NOT NULL",[job.payload.sessionId,job.payload.recordId]);
    await db.query("UPDATE photo_import_sessions SET status='importing',error_code=NULL WHERE id=$1 AND account_id=$2",[job.payload.sessionId,stream.account_id]);resumed++;
   }
  }
  return resumed;
 });
}
