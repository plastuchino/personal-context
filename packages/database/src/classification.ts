import {relatedTasks,applyTasks} from './task-extraction.js';
import type pg from 'pg';
import { labels } from '@personal-context/contracts';
import type { Classification,ModelAdapters } from '../../models/src/index.js';
import { transaction } from './records.js';
import { fence,failJob,type Job } from './jobs.js';
import { personalRules } from './personal-rules.js';
import { RULES_VERSION } from '../../classification/src/rules.js';
export function validateClassification(value:Classification):Classification {
 if(!value||!Array.isArray(value.labels)||!value.labels.length||value.labels.some(label=>!labels.includes(label)||String(label)==='unorganized')||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>4000||(value.personal_evidence!==undefined&&value.personal_evidence!==null&&(typeof value.personal_evidence!=='string'||value.personal_evidence.length>4000))||!(value.confidence===null||typeof value.confidence==='number'&&Number.isFinite(value.confidence)&&value.confidence>=0&&value.confidence<=1))throw new Error('Invalid classification output');
 return {...value,labels:[...new Set(value.labels)]};
}
export async function finishJob(db:pg.PoolClient,job:Job) {
 await db.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
}
export async function classifyJob(pool:pg.Pool,job:Job,models:Pick<ModelAdapters,'classify'> & Partial<Pick<ModelAdapters,'extractTasks'>>,classifierVersion:string):Promise<void> {
 const payload=job.payload as {recordId:string;revisionId?:string};
 const snapshot=await transaction(pool,async db=>{
  await fence(db,job);
  const row=(await db.query(`SELECT r.id,r.account_id,r.current_revision_id,r.context_version,v.title,v.body_text,
   coalesce((SELECT jsonb_agg(jsonb_build_object('kind',d.kind,'text',d.text,'model_version',d.model_version) ORDER BY d.kind,d.model_version) FROM derived_content d WHERE d.revision_id=v.id),'[]') AS derived
   FROM records r JOIN record_revisions v ON v.id=r.current_revision_id WHERE r.id=$1 AND r.account_id=$2 AND r.deleted_at IS NULL FOR UPDATE OF r`,[payload.recordId,job.account_id])).rows[0];
  if(!row||(payload.revisionId&&row.current_revision_id!==payload.revisionId)){await finishJob(db,job);return null;}
  await db.query("UPDATE classification_runs SET status='failed',error_code='classification_interrupted' WHERE job_id=$1 AND status='pending'",[job.id]);
  const evidence=await personalRules(db,row.id);
  const run=(await db.query(`INSERT INTO classification_runs(record_id,revision_id,status,classifier_version,rules_version,context_version,job_id,attempt,lease_token,evidence)
   VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(job_id,lease_token) DO UPDATE SET status='pending',evidence=excluded.evidence RETURNING id`,[row.id,row.current_revision_id,classifierVersion,RULES_VERSION,row.context_version,job.id,job.attempt,job.lease_token,JSON.stringify({personal:evidence})])).rows[0].id;
  await db.query('DELETE FROM record_labels WHERE record_id=$1',[row.id]);
  return {...row,evidence,run};
 });
 if(!snapshot)return;
 try {
  const semantic=validateClassification(await models.classify(JSON.stringify({title:snapshot.title,text:snapshot.body_text,derived:snapshot.derived,personal_evidence:snapshot.evidence,source_content_is_untrusted:true})));
  const text=[snapshot.title,snapshot.body_text,...snapshot.derived.map((d:{text:string})=>d.text)].join('\n');
  const actionQuote=snapshot.evidence.participation===null&&semantic.labels.includes('personal')&&typeof semantic.personal_evidence==='string'&&semantic.personal_evidence.trim()&&text.includes(semantic.personal_evidence)?semantic.personal_evidence:null;
  const supported:Classification['labels']=semantic.labels.filter(label=>label!=='personal');
  if(snapshot.evidence.personal||actionQuote)supported.push('personal');
  if(!supported.length)supported.push('background');
  const candidates=models.extractTasks?await relatedTasks(pool,snapshot.id,snapshot.account_id):[];
  const tasks=models.extractTasks&&(supported.includes('blocking')||candidates.length)?await models.extractTasks(JSON.stringify({source:text,related_tasks:candidates})):null;
  if(tasks&&supported.includes('blocking')&&!tasks.requests.length&&!tasks.resolutions.length)throw new Error('Blocking label requires extracted evidence');
  await transaction(pool,async db=>{
   await fence(db,job);
   const current=(await db.query('SELECT current_revision_id,context_version,deleted_at FROM records WHERE id=$1 FOR UPDATE',[snapshot.id])).rows[0];
   if(current.deleted_at||current.current_revision_id!==snapshot.current_revision_id||current.context_version!==snapshot.context_version){
    await db.query("UPDATE classification_runs SET status='failed',error_code='classification_superseded' WHERE id=$1",[snapshot.run]);await finishJob(db,job);return;
   }
   await db.query(`UPDATE classification_runs SET status='done',classified_at=now(),confidence=$2,evidence=$3 WHERE id=$1`,[snapshot.run,semantic.confidence,JSON.stringify({personal:snapshot.evidence,semantic:{...semantic,labels:supported}})]);
   await db.query('DELETE FROM record_labels WHERE record_id=$1',[snapshot.id]);
   for(const label of supported)await db.query('INSERT INTO record_labels(record_id,label,classification_run_id,reason) VALUES($1,$2,$3,$4)',[snapshot.id,label,snapshot.run,label==='personal'?JSON.stringify({rules:snapshot.evidence.reasons,source_action_quote:actionQuote}):semantic.reason]);
   if(tasks)await applyTasks(db,snapshot,text,tasks,supported.includes('blocking'));
   await finishJob(db,job);
  });
 } catch {
  await failJob(pool,job,'classification_failed');
  await transaction(pool,async db=>{
   await db.query("UPDATE classification_runs SET status='failed',error_code='classification_failed' WHERE id=$1 AND status='pending'",[snapshot.run]);
   const state=(await db.query('SELECT status,attempt FROM sync_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
   if(state.status!=='failed'||state.attempt!==job.attempt)return;
   const row=(await db.query('SELECT current_revision_id,context_version,deleted_at FROM records WHERE id=$1 FOR UPDATE',[snapshot.id])).rows[0];
   if(row.deleted_at||row.current_revision_id!==snapshot.current_revision_id||row.context_version!==snapshot.context_version)return;
   await db.query('DELETE FROM record_labels WHERE record_id=$1',[snapshot.id]);
   await db.query("INSERT INTO record_labels(record_id,label,classification_run_id,reason) VALUES($1,'unorganized',$2,'Classification failed after bounded retries; fix model service and retry the failed job')",[snapshot.id,snapshot.run]);
  });
 }
}
