import {createHash} from 'node:crypto';
import type pg from 'pg';
import {validateTasks,type TaskExtraction} from '../../models/src/tasks.js';
export async function relatedTasks(db:pg.Pool|pg.PoolClient,recordId:string,accountId:string) {
 return (await db.query(`SELECT DISTINCT t.id,t.title,t.description,t.status,t.requested_at FROM tasks t JOIN task_records e ON e.task_id=t.id JOIN records original ON original.id=e.record_id JOIN records current ON current.id=$1
 WHERE t.account_id=$2 AND current.account_id=$2 AND original.conversation_id IS NOT NULL AND original.conversation_id=current.conversation_id AND t.status IN ('open','uncertain') AND (current.kind<>'slack-message' OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=current.conversation_id AND c.kind='direct') OR EXISTS(SELECT 1 FROM slack_message_details current_message JOIN slack_message_details original_message ON original_message.record_id=original.id WHERE current_message.record_id=current.id AND coalesce(current_message.provider_thread_ts,current_message.provider_message_ts)=coalesce(original_message.provider_thread_ts,original_message.provider_message_ts))) ORDER BY t.id LIMIT 100`,[recordId,accountId])).rows;
}
export async function applyTasks(db:pg.PoolClient,record:{id:string;account_id:string;current_revision_id:string},text:string,value:TaskExtraction,blocking:boolean):Promise<void> {
 const extraction=validateTasks(value);const candidates=await relatedTasks(db,record.id,record.account_id);const allowed=new Map(candidates.map(t=>[t.id,t]));
 if(!blocking&&extraction.requests.length)throw new Error('Requests require blocking evidence');
 for(const item of [...extraction.requests,...extraction.resolutions])if(!text.includes(item.quote))throw new Error('Task quote is not exact source evidence');
 const source=(await db.query('SELECT r.source_created_at,v.captured_at,v.title,v.body_text FROM records r JOIN record_revisions v ON v.id=r.current_revision_id WHERE r.id=$1',[record.id])).rows[0];
 const artifacts=(await db.query('SELECT id,kind,text FROM derived_content WHERE revision_id=$1',[record.current_revision_id])).rows;
 const origin=(quote:string):string|null=>{
  if([source.title,source.body_text].filter((x:string)=>x.trim()).join('\n').includes(quote))return null;
  const artifact=artifacts.find(d=>d.text.includes(quote));if(!artifact)throw new Error('Task quote lacks a single source artifact');return artifact.id;
 };
 for(const request of extraction.requests){
  let taskId:string;
  if(request.existing_task_id){const original=allowed.get(request.existing_task_id);if(!original||original.title!==request.title)throw new Error('Unsupported task consolidation');taskId=original.id;}
  else {const key=createHash('sha256').update(record.id+'\0'+request.quote).digest('hex');taskId=(await db.query(`INSERT INTO tasks(account_id,title,description,status,requested_at,due_at,extraction_key) VALUES($1,$2,$3,'open',$4,$5,$6)
   ON CONFLICT(account_id,extraction_key) DO UPDATE SET title=excluded.title,description=excluded.description,due_at=excluded.due_at RETURNING id`,[record.account_id,request.title,request.description,source.source_created_at??source.captured_at,request.due_at,key])).rows[0].id;}
  await db.query(`INSERT INTO task_records(task_id,account_id,record_id,revision_id,relationship,quote,derived_content_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[taskId,record.account_id,record.id,record.current_revision_id,request.existing_task_id?'follow-up':'request',request.quote,origin(request.quote)]);
 }
 for(const resolution of extraction.resolutions){
  const task=allowed.get(resolution.task_id);if(!task)throw new Error('Resolution references an unrelated task');
  const later=source.source_created_at&&task.requested_at&&source.source_created_at.getTime()>task.requested_at.getTime();
  const status=resolution.status==='done'&&later?'done':'uncertain';
  await db.query(`INSERT INTO task_records(task_id,account_id,record_id,revision_id,relationship,quote,derived_content_id) VALUES($1,$2,$3,$4,'resolution',$5,$6) ON CONFLICT DO NOTHING`,[task.id,record.account_id,record.id,record.current_revision_id,resolution.quote,origin(resolution.quote)]);
  await db.query(`UPDATE tasks SET status=$2,resolved_at=CASE WHEN $2='done' THEN $3::timestamptz ELSE NULL END,resolution_evidence_record_id=CASE WHEN $2='done' THEN $4::uuid ELSE NULL END WHERE id=$1`,[task.id,status,source.source_created_at,record.id]);
 }
}
