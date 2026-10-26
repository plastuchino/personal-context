import type pg from 'pg';
import type {ModelAdapters} from '../../models/src/index.js';
import {validateSearch,queryFingerprint,uuid,type SearchFilters} from '../../retrieval/src/query.js';
import type {EmbeddingConfig} from './indexing.js';
import {agentRead} from './agents.js';
import {provenance} from './records.js';
const revisionFields='r.id,r.account_id,r.kind,r.external_id,r.conversation_id,r.context_version,v.id AS revision_id,v.title,v.body_text,v.source_url,v.source_created_at,v.source_updated_at,v.captured_at,(SELECT jsonb_build_object(\'provider\',a.provider,\'environment\',a.provider_environment,\'display_name\',a.display_name,\'status\',a.status,\'selection_required\',a.provider=\'google-photos\') FROM source_accounts a WHERE a.id=r.account_id) AS source';
function predicate(filters:SearchFilters,values:unknown[]):string {
 const parts=['r.deleted_at IS NULL'];const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
 for(const [key,column]of [['account_id','r.account_id'],['kind','r.kind'],['external_id','r.external_id'],['conversation_id','r.conversation_id']]as const)if(filters[key])parts.push(`${column}=${bind(filters[key])}`);
 if(filters.provider)parts.push(`EXISTS(SELECT 1 FROM source_accounts a WHERE a.id=r.account_id AND a.provider=${bind(filters.provider)})`);
 if(filters.participant){const p=bind(filters.participant);parts.push(`EXISTS(SELECT 1 FROM record_participants p JOIN identities i ON i.id=p.identity_id WHERE p.record_id=r.id AND (i.external_id=${p} OR lower(i.email)=lower(${p})))`);}
 if(filters.label)parts.push(`EXISTS(SELECT 1 FROM record_labels l JOIN classification_runs cr ON cr.id=l.classification_run_id WHERE l.record_id=r.id AND cr.revision_id=r.current_revision_id AND cr.context_version=r.context_version AND l.label=${bind(filters.label)} AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=r.conversation_id AND c.kind IN ('group','channel') AND c.relevance_check_at<=now()))`);
 if(filters.task_status)parts.push(`EXISTS(SELECT 1 FROM task_records tr JOIN tasks t ON t.id=tr.task_id WHERE tr.record_id=r.id AND t.status=${bind(filters.task_status)})`);
 if(filters.from)parts.push(`r.source_created_at>=${bind(filters.from)}::timestamptz`);if(filters.to)parts.push(`r.source_created_at<${bind(filters.to)}::timestamptz`);
 const financial:string[]=[];
 for(const [key,column]of [['amount','amount'],['currency','currency'],['merchant','merchant'],['financial_account_id','financial_account_id'],['pending','pending'],['posted_date','posted_date']]as const)if(filters[key]!==undefined)financial.push(`f.${column}=${bind(filters[key])}${key==='amount'?'::numeric':''}`);
 if(financial.length)parts.push(`EXISTS(SELECT 1 FROM financial_transaction_details f WHERE f.record_id=r.id AND ${financial.join(' AND ')})`);
 if(filters.calendar_date)parts.push(`EXISTS(SELECT 1 FROM calendar_event_details e WHERE e.record_id=r.id AND e.all_day AND e.start_date<=${bind(filters.calendar_date)}::date AND e.end_date>${bind(filters.calendar_date)}::date)`);
 if(filters.calendar_start)parts.push(`EXISTS(SELECT 1 FROM calendar_event_details e WHERE e.record_id=r.id AND e.starts_at=${bind(filters.calendar_start)}::timestamptz)`);
 return parts.join(' AND ');
}
async function freshness(db:pg.PoolClient,accountId:string) {
 return (await db.query('SELECT stream_key,coverage_start,coverage_end,coverage_complete,coverage_gap_at,last_attempt_at,last_success_at,source_watermark_at FROM sync_state WHERE account_id=$1 AND enabled ORDER BY stream_key LIMIT 100',[accountId])).rows;
}
async function structuredDetails(db:pg.PoolClient,row:any) {
 if(!(await db.query('SELECT 1 FROM records WHERE id=$1 AND current_revision_id=$2',[row.id,row.revision_id])).rowCount)return null;
 let details:unknown=null;
 if(row.kind==='calendar-event')details=(await db.query('SELECT starts_at,ends_at,timezone,start_date::text,end_date::text,all_day,recurrence_id,original_start,status,recurrence_rules FROM calendar_event_details WHERE record_id=$1',[row.id])).rows[0]??null;
 else if(row.kind==='financial-transaction')details=(await db.query('SELECT financial_account_id,amount::text,currency,merchant,pending,pending_external_id,posted_date::text FROM financial_transaction_details WHERE record_id=$1',[row.id])).rows[0]??null;
 else if(row.kind==='financial-account')details=(await db.query('SELECT id,type,currency,balance::text,balance_observed_at FROM financial_accounts WHERE source_account_id=$1 AND external_id=$2',[row.account_id,row.external_id])).rows[0]??null;
 else if(row.kind==='photo'||row.kind==='video')details=(await db.query('SELECT captured_at,mime_type,width,height,available_location,filename FROM photo_details WHERE record_id=$1',[row.id])).rows[0]??null;
 else if(row.kind==='email')details=(await db.query('SELECT message_id_header,in_reply_to,provider_labels FROM email_details WHERE record_id=$1',[row.id])).rows[0]??null;
 else if(row.kind==='slack-message')details=(await db.query('SELECT channel_id,provider_message_ts,provider_thread_ts FROM slack_message_details WHERE record_id=$1',[row.id])).rows[0]??null;
 const participants=(await db.query('SELECT i.external_id,i.email,i.display_name,i.is_self,p.role FROM record_participants p JOIN identities i ON i.id=p.identity_id WHERE p.record_id=$1 ORDER BY i.id,p.role LIMIT 100',[row.id])).rows;
 return {source:details,participants};
}
async function classificationStatus(db:pg.PoolClient,row:any) {
 const current=(await db.query('SELECT current_revision_id=$2::uuid AS current FROM records WHERE id=$1',[row.id,row.revision_id])).rows[0]?.current;
 const expired=(await db.query("SELECT 1 FROM conversations WHERE id=$1 AND kind IN ('group','channel') AND relevance_check_at<=now()",[row.conversation_id])).rowCount;
 const run=(await db.query(`SELECT cr.status,cr.classifier_version,cr.rules_version,cr.classified_at,cr.started_at,cr.error_code,cr.context_version,j.status AS job_status,cr.evidence->'personal'->'participation' AS participation FROM classification_runs cr LEFT JOIN sync_jobs j ON j.id=cr.job_id WHERE cr.record_id=$1 AND cr.revision_id=$2 ORDER BY EXISTS(SELECT 1 FROM record_labels l WHERE l.classification_run_id=cr.id) DESC,cr.context_version DESC,cr.started_at DESC,cr.id DESC LIMIT 1`,[row.id,row.revision_id])).rows[0];
 if(!current)return {status:'historical',last_run:run??null};
 if(expired||run&&run.context_version!==row.context_version)return {status:'stale',last_run:run??null};
 if(!run)return {status:'pending',last_run:null};
 return {status:run.job_status==='queued'?'retrying':run.status==='pending'?'processing':run.status,last_run:run};
}
function contentResult(row:any) {
 return {account_id:row.account_id,source:row.source,kind:row.kind,external_id:row.external_id,title:row.title,content:row.content??row.body_text.slice(0,8000),truncated:!row.content&&row.body_text.length>8000,provenance:provenance(row),chunk:row.chunk_id?{start:row.start_offset,end:row.end_offset,source_id:row.source_id,derived_content_id:row.derived_content_id,kind:row.source_kind??'source',model_version:row.model_version??null,interpretation:row.source_kind==='description'}:null};
}
export async function searchContext(pool:pg.Pool,clientId:string,input:unknown,models:Pick<ModelAdapters,'embed'>,config:EmbeddingConfig|null) {
 const query=validateSearch(input),fingerprint=queryFingerprint(query);let offset=0;
 if(query.cursor){try{const cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(cursor.f!==fingerprint||!Number.isInteger(cursor.o)||cursor.o<0||cursor.o>500)throw new Error();offset=cursor.o;}catch{throw new Error('Invalid search cursor');}}
 let vector:number[]|null=null;
 if(query.query?.trim()&&config){try{const result=await models.embed([query.query]);if(result.length!==1||result[0].length!==config.dimensions||!result[0].every(Number.isFinite)||!result[0].some(x=>x!==0))throw new Error();vector=result[0];}catch{/* Keyword/exact fallback remains usable. */}}
 return agentRead(pool,clientId,async db=>{
  await db.query("SET LOCAL statement_timeout='10s'");
  const values:unknown[]=[],where=predicate(query.filters??{},values);const searchFields=revisionFields.replace('v.body_text,',query.query?.trim()?'':'left(v.body_text,8001) AS body_text,');const eligible=`WITH eligible AS MATERIALIZED (SELECT ${searchFields} FROM records r JOIN record_revisions v ON v.id=r.current_revision_id WHERE ${where})`;
  const ranked=new Map<string,{row:any;score:number}>();let semanticAvailable=false;let modelId:string|null=null;
  if(config){const model=(await db.query('SELECT id,dimensions FROM embedding_models WHERE provider=$1 AND model_name=$2 AND version=$3',[config.adapter??'gateway',config.model,config.version])).rows[0];if(model?.dimensions===config.dimensions)modelId=model.id;}
  const chunkFields='x.*,c.id AS chunk_id,c.content,c.start_offset,c.end_offset,c.source_id,c.derived_content_id,s.kind AS source_kind,s.model_version';
  const add=(rows:any[],mode:'keyword'|'semantic')=>rows.forEach((row,index)=>{const key=row.chunk_id??row.id;const existing=ranked.get(key);ranked.set(key,{row:{...row,matched_by:[...(existing?.row.matched_by??[]),mode]},score:(existing?.score??0)+1/(60+index+1)});});
  if(query.query?.trim()){
   const keyword=await db.query(`${eligible} SELECT ${chunkFields} FROM eligible x JOIN record_chunks c ON c.revision_id=x.revision_id LEFT JOIN index_sources s ON s.id=c.source_id WHERE c.search_vector @@ websearch_to_tsquery('english',$${values.length+1}) ORDER BY ts_rank_cd(c.search_vector,websearch_to_tsquery('english',$${values.length+1})) DESC,c.id LIMIT 500`,[...values,query.query]);add(keyword.rows,'keyword');
   if(vector&&modelId&&config){
    const semantic=await db.query(`${eligible} SELECT ${chunkFields} FROM eligible x JOIN record_chunks c ON c.revision_id=x.revision_id LEFT JOIN index_sources s ON s.id=c.source_id JOIN chunk_embeddings e ON e.chunk_id=c.id WHERE e.embedding_model_id=$${values.length+1} ORDER BY e.embedding::vector(${config.dimensions}) <=> $${values.length+2}::vector(${config.dimensions}),c.id LIMIT 500`,[...values,modelId,JSON.stringify(vector)]);add(semantic.rows,'semantic');semanticAvailable=true;
   }
  }else{
   const exact=await db.query(`${eligible} SELECT * FROM eligible ORDER BY source_created_at DESC NULLS LAST,id LIMIT 501`,values);exact.rows.forEach((row,n)=>ranked.set(row.id,{row,score:1/(60+n+1)}));
  }
  const records=new Map<string,{row:any;score:number}>();for(const item of [...ranked.values()].sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id)))if(!records.has(item.row.id))records.set(item.row.id,item);
  const all=[...records.values()],limit=query.limit??20,selected=all.slice(offset,offset+limit);
  const results=[];for(const item of selected)results.push({...contentResult(item.row),details:await structuredDetails(db,item.row),classification:await classificationStatus(db,item.row),score:item.score,matched_by:item.row.matched_by??['exact'],freshness:await freshness(db,item.row.account_id)});
  const coverage=(await db.query(`SELECT count(*)::int AS current_records,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM index_sources s WHERE s.revision_id=r.current_revision_id))::int AS keyword_records,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM record_chunks c WHERE c.revision_id=r.current_revision_id) AND NOT EXISTS(SELECT 1 FROM record_chunks c WHERE c.revision_id=r.current_revision_id AND NOT EXISTS(SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id=c.id AND e.embedding_model_id=$1)))::int AS embedded_records FROM records r WHERE r.deleted_at IS NULL`,[modelId])).rows[0];
  return {results,next_cursor:offset+limit<all.length&&offset+limit<=500?Buffer.from(JSON.stringify({f:fingerprint,o:offset+limit})).toString('base64url'):null,coverage:{...coverage,semantic_available:semanticAvailable,embedding_model_id:modelId,candidate_limit_per_method:500}};
 });
}
export async function getRevision(pool:pg.Pool,clientId:string,recordId:string,revisionId?:string,chunkId?:string,textOffset=0,textLimit=8000) {
 if(!uuid.test(recordId)||(revisionId&&!uuid.test(revisionId))||(chunkId&&!uuid.test(chunkId))||!Number.isInteger(textOffset)||textOffset<0||textOffset>10000000||!Number.isInteger(textLimit)||textLimit<1||textLimit>16000)throw new Error('Invalid lookup');
 return agentRead(pool,clientId,async db=>{
  const row=(await db.query(`SELECT ${revisionFields},r.deleted_at FROM records r JOIN record_revisions v ON v.record_id=r.id WHERE r.id=$1 AND v.id=coalesce($2::uuid,r.current_revision_id)`,[recordId,revisionId??null])).rows[0];if(!row)return null;
  if(chunkId){const chunk=(await db.query('SELECT c.id AS chunk_id,c.content,c.start_offset,c.end_offset,c.source_id,c.derived_content_id,s.kind AS source_kind,s.model_version FROM record_chunks c LEFT JOIN index_sources s ON s.id=c.source_id WHERE c.id=$1 AND c.revision_id=$2',[chunkId,row.revision_id])).rows[0];if(!chunk)return null;Object.assign(row,chunk);}
  const result=contentResult(row);if(!chunkId){result.content=row.body_text.slice(textOffset,textOffset+textLimit);result.truncated=textOffset+textLimit<row.body_text.length;}
  const labels=(await db.query(`SELECT l.label,l.reason,cr.classifier_version,cr.classified_at FROM record_labels l JOIN classification_runs cr ON cr.id=l.classification_run_id WHERE l.record_id=$1 AND cr.revision_id=$2 AND cr.context_version=$3 AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=$4 AND c.kind IN ('group','channel') AND c.relevance_check_at<=now())`,[recordId,row.revision_id,row.context_version,row.conversation_id])).rows;
  const derived=(await db.query('SELECT id,kind,left(text,8000) AS text,length(text)>8000 AS truncated,model_version FROM derived_content WHERE revision_id=$1 ORDER BY id LIMIT 20',[row.revision_id])).rows;
  return {...result,details:await structuredDetails(db,row),classification:await classificationStatus(db,row),deleted_at:row.deleted_at,labels,derived:derived.map(d=>({...d,interpretation:d.kind==='description',provenance:provenance({...row,chunk_id:null})})),text_offset:textOffset,next_offset:!chunkId&&result.truncated?textOffset+textLimit:null,freshness:await freshness(db,row.account_id)};
 });
}
export async function sourceStatus(pool:pg.Pool,clientId:string) {
 return agentRead(pool,clientId,async db=>({accounts:(await db.query(`SELECT a.id,a.provider,a.display_name,a.status,a.provider_environment,(a.provider='google-photos') AS selection_required,(SELECT count(*)::int FROM records r WHERE r.account_id=a.id AND r.deleted_at IS NULL) AS records FROM source_accounts a ORDER BY a.id LIMIT 100`)).rows,streams:(await db.query('SELECT account_id,stream_key,coverage_start,coverage_end,coverage_complete,coverage_gap_at,last_attempt_at,last_success_at,source_watermark_at FROM sync_state WHERE enabled ORDER BY account_id,stream_key LIMIT 1000')).rows,slack:(await db.query('SELECT account_id,status,connected_at,last_event_received_at,last_event_processed_at,gap_started_at,last_reconciled_at,coverage_complete,error_code FROM slack_connection_state ORDER BY account_id LIMIT 100')).rows,limits:{accounts:100,streams:1000}}));
}
export async function blockingTasks(pool:pg.Pool,clientId:string,status='open',limit=20) {
 if(!['open','done','uncertain'].includes(status)||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid task query');
 return agentRead(pool,clientId,async db=>{
  const tasks=(await db.query('SELECT id,account_id,title,description,status,requested_at,due_at,resolved_at FROM tasks WHERE status=$1 ORDER BY due_at ASC NULLS LAST,id LIMIT $2',[status,limit])).rows;const results=[];
  for(const task of tasks){const evidence=(await db.query(`SELECT ${revisionFields},r.current_revision_id=v.id AS evidence_current,r.deleted_at IS NOT NULL AS source_deleted,tr.relationship,tr.quote,tr.derived_content_id,d.kind AS evidence_kind,d.model_version AS evidence_model_version FROM task_records tr JOIN records r ON r.id=tr.record_id JOIN record_revisions v ON v.id=tr.revision_id LEFT JOIN derived_content d ON d.id=tr.derived_content_id WHERE tr.task_id=$1 ORDER BY v.captured_at,r.id LIMIT 100`,[task.id])).rows;results.push({...task,evidence:evidence.map(row=>({relationship:row.relationship,source:row.source,derived_content_id:row.derived_content_id,interpretation:row.evidence_kind==='description',model_version:row.evidence_model_version,quote:row.quote??row.body_text.slice(0,2000),provenance:provenance(row),source_is_current:row.evidence_current,source_deleted:row.source_deleted})),freshness:await freshness(db,task.account_id)});}
  return {tasks:results};
 });
}
