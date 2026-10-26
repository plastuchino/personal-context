import { Hono } from 'hono';
import type pg from 'pg';
import { transaction } from '../../../packages/database/src/records.js';
import { retryJob } from '../../../packages/database/src/jobs.js';
import {historyFilter,historyPage} from '../../../packages/database/src/operations-history.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function operations(pool:pg.Pool) {
 const routes=new Hono();
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 routes.get('/overview',async c=>{
  const [size,stages,streams,sources,records,slack,classifications]=await Promise.all([
   pool.query('SELECT pg_database_size(current_database())::text AS database_bytes,coalesce(sum(byte_size),0)::text AS media_bytes FROM media_assets'),
   pool.query('SELECT stage,status,count(*)::int AS count FROM sync_jobs GROUP BY stage,status ORDER BY stage,status'),
   pool.query(`SELECT s.account_id,s.stream_key,s.enabled,s.coverage_start,s.coverage_end,s.coverage_complete,s.coverage_gap_at,s.last_attempt_at,s.last_success_at,s.source_watermark_at,s.next_check_at,j.status AS last_job_status,j.error_code
    FROM sync_state s LEFT JOIN LATERAL (SELECT status,error_code FROM sync_jobs WHERE account_id=s.account_id AND stream_key=s.stream_key AND stage='ingest' ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
    WHERE s.enabled ORDER BY s.account_id,s.stream_key`),
   pool.query(`SELECT a.id AS account_id,a.provider,a.display_name,a.status,a.provider_environment,count(r.id)::int AS count,
    (SELECT max(created_at) FROM photo_import_sessions p WHERE p.account_id=a.id) AS last_import_at
    FROM source_accounts a LEFT JOIN records r ON r.account_id=a.id AND r.deleted_at IS NULL GROUP BY a.id ORDER BY a.provider,a.display_name`),
   pool.query(`SELECT count(*) FILTER(WHERE deleted_at IS NULL)::int AS total,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted,
    count(*) FILTER(WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM classification_runs cr WHERE cr.record_id=records.id AND cr.revision_id=records.current_revision_id AND cr.context_version=records.context_version AND (cr.status='done' OR EXISTS(SELECT 1 FROM record_labels l WHERE l.classification_run_id=cr.id AND l.record_id=records.id AND l.label='unorganized'))))::int AS pending_stale FROM records`),
   pool.query(`SELECT s.account_id,s.status,s.app_credential_ref IS NOT NULL AS token_configured,s.connected_at,s.last_event_received_at,s.last_event_processed_at,s.last_reconciled_at,s.gap_started_at,s.coverage_complete,s.error_code,
    (SELECT count(*)::int FROM slack_event_inbox i WHERE i.account_id=s.account_id AND i.status='queued') AS inbox_backlog,
    (SELECT min(received_at) FROM slack_event_inbox i WHERE i.account_id=s.account_id AND i.status='queued') AS oldest_pending_at FROM slack_connection_state s`),
   pool.query(`SELECT labels.label,count(DISTINCT r.id)::int AS count FROM unnest(ARRAY['personal','background','blocking','update','unorganized']) AS labels(label)
    LEFT JOIN record_labels l ON l.label=labels.label LEFT JOIN classification_runs cr ON cr.id=l.classification_run_id
    LEFT JOIN records r ON r.id=l.record_id AND r.deleted_at IS NULL AND cr.revision_id=r.current_revision_id AND cr.context_version=r.context_version
     AND (cr.status='done' OR labels.label='unorganized' AND cr.status='failed') GROUP BY labels.label ORDER BY labels.label`),
  ]);
  return c.json({storage:size.rows[0],stages:stages.rows,streams:streams.rows,sources:sources.rows,records:records.rows[0],slack:slack.rows,classifications:classifications.rows});
 });
 for(const kind of ['jobs','failures'] as const) routes.get('/'+kind,async c=>{
  let filter;try{filter=historyFilter(c.req.query(),kind);}catch{return c.json({error:'Invalid history filters or cursor'},400);}
  return c.json(await historyPage(pool,kind,filter));
 });
 routes.post('/jobs/:id/retry',async c=>{
  const id=c.req.param('id');if(!uuid.test(id))return c.json({error:'Invalid identifier'},400);
  const retried=await retryJob(pool,id);
  return retried?c.json({queued:true}):c.json({error:'Job is unavailable or its stream has active work. Expired Photos selections require Choose photos again.'},409);
 });
 routes.get('/agents',async c=>c.json({agents:(await pool.query(`SELECT a.id,a.name,a.created_at,a.revoked_at,coalesce(array_agg(g.account_id) FILTER(WHERE g.account_id IS NOT NULL),'{}') AS accounts FROM agent_clients a LEFT JOIN access_grants g ON g.client_id=a.id GROUP BY a.id ORDER BY a.created_at DESC`)).rows}));
 routes.get('/conversations',async c=>{
  const after=c.req.query('after');if(after&&!uuid.test(after))return c.json({error:'Invalid cursor'},400);
  const rows=(await pool.query('SELECT id,account_id,external_id,kind,title,personal_override FROM conversations WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 51',[after??null])).rows;
  return c.json({conversations:rows.slice(0,50),next_cursor:rows.length>50?rows[49].id:null});
 });
 routes.put('/conversations/:id/personal',async c=>{
  const id=c.req.param('id');if(!uuid.test(id))return c.json({error:'Invalid identifier'},400);
  let body:unknown;try{body=await c.req.json();}catch{return c.json({error:'Invalid request'},400);}
  if(!body||typeof body!=='object'||!('personal'in body)||typeof body.personal!=='boolean')return c.json({error:'Personal must be a boolean'},400);
  const personal=body.personal;
  const found=await transaction(pool,async db=>{
   const row=(await db.query('UPDATE conversations SET personal_override=$2 WHERE id=$1 RETURNING account_id',[id,personal])).rows[0];if(!row)return false;
   const stream=`conversation:${id}`;
   await db.query('INSERT INTO sync_state(account_id,stream_key,enabled) VALUES($1,$2,false) ON CONFLICT DO NOTHING',[row.account_id,stream]);
   await db.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'reclassify',$3,$4) ON CONFLICT DO NOTHING`,[row.account_id,stream,`conversation-personal:${id}:${personal}`,{conversationId:id}]);
   return true;
  });
  return found?c.json({personal_override:personal}):c.json({error:'Conversation not found'},404);
 });
 return routes;
}
