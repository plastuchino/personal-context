import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Provenance } from '@personal-context/contracts';

export interface SourceRecord {
 accountId: string; externalId: string; kind: string; conversationId?: string | null;
 sourceUrl?: string | null; sourceCreatedAt?: string | null; sourceUpdatedAt?: string | null;
 conversation?: {externalId:string;kind:string;title:string};
 participants?: {externalId:string;email?:string;displayName?:string;isSelf:boolean;role:string}[];
 slack?: {channelId:string;messageTs:string;threadTs:string|null;version?:string};
 calendar?: {allDay:boolean;startDate:string|null;endDate:string|null;startsAt:string|null;endsAt:string|null;timezone:string|null;recurrenceId:string|null;originalStart:string|null;recurrenceRules:string[];status:string};
 email?: {messageIdHeader:string|null;inReplyTo:string|null;labels:string[]};
 financialAccount?: {externalId:string;type:string;currency:string|null;balance:string|null;observedAt:string};
 financial?: {externalAccountId:string;amount:string;currency:string;merchant:string|null;pending:boolean;pendingExternalId:string|null;postedDate:string|null};
 photo?: {capturedAt:string|null;mimeType:string;width:number|null;height:number|null;filename:string|null};
 hashPayload?: unknown;
 rawJson?: string;
 title?: string; bodyText: string; rawPayload: unknown; deleted?: boolean;
}
function stable(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
 if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+stable(v)).join(',') + '}';
 const result = JSON.stringify(value);
 if (result === undefined) throw new Error('Source payload must be JSON serializable');
 return result;
}
export async function transaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
 const c = await pool.connect();
 try { await c.query('BEGIN'); const result = await run(c); await c.query('COMMIT'); return result; }
 catch(error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}

// Caller owns transaction, allowing the same commit to persist page checkpoints.
export async function upsertRecord(c: pg.PoolClient, source: SourceRecord): Promise<{ recordId: string; revisionId: string | null; changed: boolean }> {
 if(source.financial?.pending){
  const replaced=await c.query(`SELECT 1 FROM financial_transaction_details f JOIN records r ON r.id=f.record_id
   WHERE r.account_id=$1 AND NOT f.pending AND f.pending_external_id=$2`,[source.accountId,source.externalId]);
  if(replaced.rowCount)source={...source,deleted:true};
 }
 if(source.slack){
  const v=source.slack.version??source.slack.messageTs;
  if(!/^\d+\.\d{1,6}$/.test(v))throw new Error('Invalid Slack version');
  await c.query(`INSERT INTO slack_message_versions(account_id,channel_id,message_ts,version,deleted) VALUES($1,$2,$3,-1,false) ON CONFLICT DO NOTHING`,[source.accountId,source.slack.channelId,source.slack.messageTs]);
  const prior=(await c.query('SELECT record_id,version >= $4::numeric AS stale FROM slack_message_versions WHERE account_id=$1 AND channel_id=$2 AND message_ts=$3 FOR UPDATE',[source.accountId,source.slack.channelId,source.slack.messageTs,v])).rows[0];
  if(source.slack.threadTs)await c.query('INSERT INTO slack_threads(account_id,channel_id,thread_ts) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.accountId,source.slack.channelId,source.slack.threadTs]);
  if(prior.stale&&prior.record_id){
   const old=(await c.query('SELECT current_revision_id FROM records WHERE id=$1',[prior.record_id])).rows[0];
   return {recordId:prior.record_id,revisionId:old.current_revision_id,changed:false};
  }
 }
 let conversationId=source.conversationId??null;
 if(source.conversation)conversationId=(await c.query(`INSERT INTO conversations(account_id,external_id,kind,title) VALUES($1,$2,$3,$4)
 ON CONFLICT(account_id,external_id) DO UPDATE SET title=excluded.title RETURNING id`,[source.accountId,source.conversation.externalId,source.conversation.kind,source.conversation.title])).rows[0].id;
 if(source.rawJson)JSON.parse(source.rawJson); // validate syntax without using rounded JS numbers for persistence
 const raw = source.rawJson ?? JSON.parse(stable(source.rawPayload));
 const hash = createHash('sha256').update(stable({ title: source.title ?? '', body: source.bodyText, raw: source.hashPayload??raw, sourceUrl: source.sourceUrl ?? null, sourceCreatedAt: source.sourceCreatedAt ?? null, sourceUpdatedAt: source.sourceUpdatedAt ?? null, conversationId: conversationId })).digest('hex');
 const {rows} = await c.query(`INSERT INTO records(account_id,external_id,kind,conversation_id,source_url,source_created_at,source_updated_at,deleted_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now() ELSE NULL END)
 ON CONFLICT(account_id,kind,external_id) DO UPDATE SET last_seen_at=now()
 RETURNING id,current_revision_id,deleted_at`,[source.accountId,source.externalId,source.kind,conversationId,source.sourceUrl ?? null,source.sourceCreatedAt ?? null,source.sourceUpdatedAt ?? null,!!source.deleted]);
 const record = rows[0];
 const saveSlackVersion=async()=>{
  if(source.slack)await c.query(`UPDATE slack_message_versions SET version=$4::numeric,deleted=$5,record_id=$6 WHERE account_id=$1 AND channel_id=$2 AND message_ts=$3`,[source.accountId,source.slack.channelId,source.slack.messageTs,source.slack.version??source.slack.messageTs,!!source.deleted,record.id]);
  if(source.slack?.threadTs)await c.query('INSERT INTO slack_threads(account_id,channel_id,thread_ts) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.accountId,source.slack.channelId,source.slack.threadTs]);
 };
 if (source.deleted) {
  await c.query('UPDATE records SET deleted_at=coalesce(deleted_at,now()) WHERE id=$1',[record.id]);
  if(source.kind==='calendar-event')await c.query(`UPDATE records SET deleted_at=coalesce(deleted_at,now()) WHERE account_id=$1 AND id IN (SELECT record_id FROM calendar_event_details WHERE recurrence_id=$2)`,[source.accountId,source.externalId]);
  await saveSlackVersion();
  return { recordId: record.id, revisionId: record.current_revision_id, changed: !record.deleted_at };
 }
 const prior = await c.query('SELECT content_hash,revision_number FROM record_revisions WHERE id=$1',[record.current_revision_id]);
 const changed = prior.rows[0]?.content_hash !== hash;
 let revisionId: string = record.current_revision_id;
 if (changed) {
  revisionId = (await c.query(`INSERT INTO record_revisions(record_id,revision_number,title,body_text,raw_payload,content_hash,source_url,source_created_at,source_updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[record.id,(prior.rows[0]?.revision_number ?? 0)+1,source.title ?? '',source.bodyText,raw,hash,source.sourceUrl ?? null,source.sourceCreatedAt ?? null,source.sourceUpdatedAt ?? null])).rows[0].id;
 }
 if(source.photo){
  const p=source.photo;
  await c.query(`INSERT INTO photo_details(record_id,captured_at,mime_type,width,height,filename) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(record_id) DO UPDATE SET captured_at=excluded.captured_at,mime_type=excluded.mime_type,width=excluded.width,height=excluded.height,filename=excluded.filename`,[record.id,p.capturedAt,p.mimeType,p.width,p.height,p.filename]);
 }
 if(source.financialAccount){
  const a=source.financialAccount;
  await c.query(`INSERT INTO financial_accounts(source_account_id,external_id,type,currency,balance,balance_observed_at) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(source_account_id,external_id) DO UPDATE SET type=excluded.type,currency=excluded.currency,balance=excluded.balance,balance_observed_at=excluded.balance_observed_at`,[source.accountId,a.externalId,a.type,a.currency,a.balance,a.observedAt]);
 }
 if(source.financial){
  const f=source.financial;
  const account=(await c.query('SELECT id FROM financial_accounts WHERE source_account_id=$1 AND external_id=$2',[source.accountId,f.externalAccountId])).rows[0];
  if(!account)throw new Error('Financial account context missing');
  await c.query(`INSERT INTO financial_transaction_details(record_id,source_account_id,financial_account_id,amount,currency,merchant,pending,pending_external_id,posted_date)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(record_id) DO UPDATE SET financial_account_id=excluded.financial_account_id,amount=excluded.amount,currency=excluded.currency,merchant=excluded.merchant,pending=excluded.pending,pending_external_id=excluded.pending_external_id,posted_date=excluded.posted_date`,[record.id,source.accountId,account.id,f.amount,f.currency,f.merchant,f.pending,f.pendingExternalId,f.postedDate]);
  if(!f.pending&&f.pendingExternalId)await c.query(`UPDATE records SET deleted_at=coalesce(deleted_at,now()) WHERE account_id=$1 AND kind='financial-transaction' AND external_id=$2`,[source.accountId,f.pendingExternalId]);
 }
 if(source.calendar){
  const d=source.calendar;
  await c.query(`INSERT INTO calendar_event_details(record_id,starts_at,ends_at,timezone,start_date,end_date,all_day,recurrence_id,original_start,status,recurrence_rules)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(record_id) DO UPDATE SET starts_at=excluded.starts_at,ends_at=excluded.ends_at,timezone=excluded.timezone,start_date=excluded.start_date,end_date=excluded.end_date,all_day=excluded.all_day,recurrence_id=excluded.recurrence_id,original_start=excluded.original_start,status=excluded.status,recurrence_rules=excluded.recurrence_rules`,[record.id,d.startsAt,d.endsAt,d.timezone,d.startDate,d.endDate,d.allDay,d.recurrenceId,d.originalStart,d.status,d.recurrenceRules]);
 }
 if(source.slack)await c.query(`INSERT INTO slack_message_details(record_id,channel_id,provider_message_ts,provider_thread_ts) VALUES($1,$2,$3,$4)
 ON CONFLICT(record_id) DO UPDATE SET provider_thread_ts=excluded.provider_thread_ts`,[record.id,source.slack.channelId,source.slack.messageTs,source.slack.threadTs]);
 if(source.email)await c.query(`INSERT INTO email_details(record_id,message_id_header,in_reply_to,provider_labels) VALUES($1,$2,$3,$4)
 ON CONFLICT(record_id) DO UPDATE SET message_id_header=excluded.message_id_header,in_reply_to=excluded.in_reply_to,provider_labels=excluded.provider_labels`,[record.id,source.email.messageIdHeader,source.email.inReplyTo,source.email.labels]);
 if(source.participants){
  await c.query('DELETE FROM record_participants WHERE record_id=$1',[record.id]);
  for(const person of source.participants){
   const identity=(await c.query(`INSERT INTO identities(account_id,external_id,email,display_name,is_self) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(account_id,external_id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,is_self=excluded.is_self RETURNING id`,[source.accountId,person.externalId,person.email??null,person.displayName??null,person.isSelf])).rows[0].id;
   await c.query('INSERT INTO record_participants(record_id,account_id,identity_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[record.id,source.accountId,identity,person.role]);
  }
 }
 await c.query(`UPDATE records SET current_revision_id=$2,conversation_id=$3,source_url=$4,source_created_at=$5,source_updated_at=$6,deleted_at=NULL WHERE id=$1`,[record.id,revisionId,conversationId,source.sourceUrl ?? null,source.sourceCreatedAt ?? null,source.sourceUpdatedAt ?? null]);
 await saveSlackVersion();
 return { recordId: record.id, revisionId, changed };
}

export function provenance(row: { id: string; revision_id: string | null; chunk_id?: string | null; source_url: string | null; source_created_at: Date | null; source_updated_at: Date | null; captured_at: Date }): Provenance {
 const suffix = row.revision_id ? `/revisions/${row.revision_id}` : '';
 return {record_id:row.id,record_uri:`personal-context://records/${row.id}${suffix}${row.chunk_id ? `/chunks/${row.chunk_id}` : ''}`,revision_id:row.revision_id,chunk_id:row.chunk_id ?? null,source_url:row.source_url,source_created_at:row.source_created_at?.toISOString() ?? null,source_updated_at:row.source_updated_at?.toISOString() ?? null,ingested_at:row.captured_at.toISOString()};
}
