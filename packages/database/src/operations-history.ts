import type pg from 'pg';
export const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type HistoryKind='jobs'|'failures'|'imports';
export interface HistoryFilter {source:string|null;status:string|null;from:string|null;to:string|null;after:{time:string;type:string;id:string}|null;identity:string}
const statuses={jobs:['queued','running','done','failed'],imports:['selecting','selected','importing','done','failed','expired'],failures:['failed','expired']};
function timestamp(value:string) {
 const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/.exec(value);
 if(!match||!Number.isFinite(Date.parse(value)))return false;
 const [,year,month,day,hour,minute,second]=match;
 const days=new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
 return Number(month)>=1&&Number(month)<=12&&Number(day)>=1&&Number(day)<=days&&Number(hour)<24&&Number(minute)<60&&Number(second)<60;
}
export function historyFilter(query:Record<string,string>,kind:HistoryKind):HistoryFilter {
 const source=query.source||null,status=query.status||null,from=query.from||null,to=query.to||null;
 if(source&&!uuidPattern.test(source)||status&&!statuses[kind].includes(status)||from&&!timestamp(from)||to&&!timestamp(to)||from&&to&&Date.parse(from)>=Date.parse(to))throw new Error('Invalid history filters');
 const identity=JSON.stringify([kind,source,status,from,to]);let after:HistoryFilter['after']=null;
 if(query.cursor){
  if(query.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw new Error('Invalid history cursor');
  let cursor;try{cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());}catch{throw new Error('Invalid history cursor');}
  if(cursor?.v!==1||cursor.identity!==identity||typeof cursor.time!=='string'||!timestamp(cursor.time)||typeof cursor.id!=='string'||!uuidPattern.test(cursor.id)||!['job','import'].includes(cursor.type)||kind==='jobs'&&cursor.type!=='job'||kind==='imports'&&cursor.type!=='import')throw new Error('Invalid history cursor');
  after={time:cursor.time,type:cursor.type,id:cursor.id};
 }
 return {source,status,from,to,after,identity};
}
export async function historyPage(pool:pg.Pool,kind:HistoryKind,filter:HistoryFilter) {
 const job=`SELECT id,account_id,'job'::text AS entry_type,created_at,stage,status,stream_key,error_code,scheduled_at,started_at,finished_at,attempt,max_attempts FROM sync_jobs`;
 const photo=`SELECT id,account_id,'import'::text AS entry_type,created_at,'photo'::text AS stage,status,NULL::text AS stream_key,error_code,NULL::timestamptz AS scheduled_at,NULL::timestamptz AS started_at,NULL::timestamptz AS finished_at,NULL::integer AS attempt,NULL::integer AS max_attempts FROM photo_import_sessions`;
 const source=kind==='jobs'?job:kind==='imports'?photo:`${job} WHERE status='failed' UNION ALL ${photo} WHERE status IN ('failed','expired')`;
 const rows=(await pool.query(`SELECT h.*,h.created_at::text AS cursor_time FROM (${source}) h
 WHERE ($1::uuid IS NULL OR account_id=$1) AND ($2::text IS NULL OR status=$2)
 AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4)
 AND ($5::timestamptz IS NULL OR (created_at,entry_type,id)<($5,$6::text,$7::uuid))
 ORDER BY created_at DESC,entry_type DESC,id DESC LIMIT 51`,[filter.source,filter.status,filter.from,filter.to,filter.after?.time??null,filter.after?.type??null,filter.after?.id??null])).rows;
 const page=rows.slice(0,50),last=page.at(-1);
 const next_cursor=rows.length>50?Buffer.from(JSON.stringify({v:1,identity:filter.identity,time:last.cursor_time,type:last.entry_type,id:last.id})).toString('base64url'):null;
 return {items:page.map(({cursor_time,...row})=>row),next_cursor};
}
