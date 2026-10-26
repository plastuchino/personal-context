import type pg from 'pg';
import { transaction } from './records.js';
import { fence,type Job } from './jobs.js';
import { finishJob } from './classification.js';
export async function scheduleClassifications(pool:pg.Pool,classifierVersion:string,now=new Date(),accountId?:string):Promise<number> {
 return transaction(pool,async db=>{
  // Reevaluate at the next exact message expiry, with a daily fallback for quiet groups.
  const groups=(await db.query("SELECT id FROM conversations WHERE kind IN ('group','channel') AND relevance_check_at<=$1 AND ($2::uuid IS NULL OR account_id=$2) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100",[now,accountId??null])).rows;
  for(const group of groups){
   await db.query('UPDATE records SET context_version=context_version+1 WHERE conversation_id=$1',[group.id]);
   await db.query('DELETE FROM record_labels WHERE record_id IN (SELECT id FROM records WHERE conversation_id=$1)',[group.id]);
   await db.query(`UPDATE conversations SET relevance_check_at=least($2::timestamptz+interval '1 day',coalesce((SELECT min(source_created_at)+interval '7 days' FROM records WHERE conversation_id=$1 AND deleted_at IS NULL AND source_created_at>$2::timestamptz-interval '7 days'),$2::timestamptz+interval '1 day')) WHERE id=$1`,[group.id,now]);
  }
  // Final lease exhaustion is observable just like a bounded model failure.
  const abandoned=(await db.query(`UPDATE classification_runs cr SET status='failed',error_code='classification_interrupted' FROM sync_jobs j
   WHERE cr.job_id=j.id AND cr.status='pending' AND j.status='failed' RETURNING cr.*`)).rows;
  for(const run of abandoned)await db.query(`INSERT INTO record_labels(record_id,label,classification_run_id,reason)
   SELECT r.id,'unorganized',$2,'Worker attempts exhausted; retry the failed classification job' FROM records r
   WHERE r.id=$1 AND r.current_revision_id=$3 AND r.context_version=$4 AND r.deleted_at IS NULL ON CONFLICT(record_id,label) DO NOTHING`,[run.record_id,run.id,run.revision_id,run.context_version]);
  const rows=(await db.query(`SELECT r.id,r.account_id,r.current_revision_id,r.context_version FROM records r WHERE r.deleted_at IS NULL AND r.current_revision_id IS NOT NULL AND ($2::uuid IS NULL OR r.account_id=$2)
   AND NOT EXISTS(SELECT 1 FROM classification_runs cr WHERE cr.record_id=r.id AND cr.revision_id=r.current_revision_id AND cr.context_version=r.context_version AND cr.classifier_version=$1)
   AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.stage='classify' AND j.payload->>'recordId'=r.id::text AND j.status IN ('queued','running'))
   ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 100`,[classifierVersion,accountId??null])).rows;
  for(const row of rows){const stream=`derived:${row.id}`;await db.query('INSERT INTO sync_state(account_id,stream_key,enabled) VALUES($1,$2,false) ON CONFLICT DO NOTHING',[row.account_id,stream]);await db.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'classify',$3,$4) ON CONFLICT DO NOTHING`,[row.account_id,stream,`classify:${row.id}:${row.context_version}:${classifierVersion}`,{recordId:row.id,revisionId:row.current_revision_id}]);}
  return rows.length;
 });
}
export async function processReclassification(pool:pg.Pool,job:Job,classifierVersion:string|null):Promise<void> {
 // Source/override triggers already invalidated affected records transactionally.
 await transaction(pool,async db=>{await fence(db,job);await finishJob(db,job);});
 if(classifierVersion)await scheduleClassifications(pool,classifierVersion);
}
