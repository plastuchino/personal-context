import type pg from 'pg';
import { participation,WINDOW_MS,RULES_VERSION } from '../../classification/src/rules.js';
export interface PersonalEvidence {personal:boolean;rulesVersion:string;reasons:{kind:string;recordId?:string}[];participation:ReturnType<typeof participation>|null;evaluatedAt:string}
// Queries use the current source snapshot; no model can invent owner participation.
export async function personalRules(db:pg.Pool|pg.PoolClient,recordId:string,now=new Date()):Promise<PersonalEvidence> {
 const result:PersonalEvidence={personal:false,rulesVersion:RULES_VERSION,reasons:[],participation:null,evaluatedAt:now.toISOString()};
 const record=(await db.query(`SELECT r.*,c.kind AS conversation_kind,c.personal_override,c.external_id AS conversation_external_id,e.in_reply_to,s.provider_thread_ts,v.raw_payload
 FROM records r JOIN record_revisions v ON v.id=r.current_revision_id LEFT JOIN conversations c ON c.id=r.conversation_id LEFT JOIN email_details e ON e.record_id=r.id LEFT JOIN slack_message_details s ON s.record_id=r.id WHERE r.id=$1 AND r.deleted_at IS NULL`,[recordId])).rows[0];
 if(!record)return result;
 const own=(await db.query(`SELECT 1 FROM record_participants p JOIN identities i ON i.id=p.identity_id WHERE p.record_id=$1 AND i.is_self AND p.role IN ('sender','author')`,[recordId])).rowCount;
 if(own)result.reasons.push({kind:'owner-authored',recordId});
 if(record.conversation_id&&['group','channel'].includes(record.conversation_kind)) {
  const start=new Date(now.getTime()-WINDOW_MS);
  const counts=(await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM record_participants p JOIN identities i ON i.id=p.identity_id WHERE p.record_id=r.id AND i.is_self AND p.role IN ('author','sender')))::int AS self
   FROM records r WHERE r.conversation_id=$1 AND r.deleted_at IS NULL AND r.source_created_at>$2 AND r.source_created_at<=$3`,[record.conversation_id,start,now])).rows[0];
  const coverage=(await db.query(`SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 AND coverage_complete AND coverage_gap_at IS NULL AND coverage_start<=$3 AND coverage_end>=$4`,[record.account_id,`channel:${record.conversation_external_id}`,start,now])).rowCount;
  result.participation=participation(counts.self,counts.total,record.personal_override,Boolean(coverage));
  if(result.participation.personal)result.reasons.push({kind:result.participation.reason!});
  // In a group, only the explicit participation rule establishes conversation relevance.
  result.reasons=result.reasons.filter(r=>r.kind!=='owner-authored');
 } else {
  if(record.personal_override)result.reasons.push({kind:'override'});
  if(record.in_reply_to){
   const parent=(await db.query(`SELECT r.id FROM records r JOIN email_details e ON e.record_id=r.id WHERE r.account_id=$1 AND r.kind='email' AND e.message_id_header=$2 AND r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM record_participants p JOIN identities i ON i.id=p.identity_id WHERE p.record_id=r.id AND p.role='sender' AND i.is_self) LIMIT 1`,[record.account_id,record.in_reply_to])).rows[0];
   if(parent)result.reasons.push({kind:'reply-to-owner',recordId:parent.id});
  }
  if(record.provider_thread_ts&&record.conversation_kind==='direct'){
   const parent=(await db.query(`SELECT r.id FROM records r JOIN slack_message_details s ON s.record_id=r.id WHERE r.account_id=$1 AND r.conversation_id=$2 AND s.provider_message_ts=$3 AND r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM record_participants p JOIN identities i ON i.id=p.identity_id WHERE p.record_id=r.id AND p.role='author' AND i.is_self) LIMIT 1`,[record.account_id,record.conversation_id,record.provider_thread_ts])).rows[0];
   if(parent)result.reasons.push({kind:'reply-to-owner',recordId:parent.id});
  }
  if(record.kind==='calendar-event'&&(record.raw_payload?.creator?.self===true||record.raw_payload?.organizer?.self===true))result.reasons.push({kind:'owner-created-calendar-event',recordId});
 }
 result.personal=result.reasons.length>0;return result;
}
