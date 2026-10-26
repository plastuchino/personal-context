import type pg from 'pg';
import { transaction } from './records.js';

export interface SlackEventBody {
 type?: string; api_app_id?: string; team_id?: string; event_id?: string;
 authorizations?: { team_id?: string; user_id?: string; is_bot?: boolean }[];
 event?: { type?: string; subtype?: string; channel?: string; ts?: string; event_ts?: string; deleted_ts?: string; message?: {ts?:string}; [key:string]:unknown };
}
export async function receiveSlackEvent(pool:pg.Pool,accountId:string,envelopeId:string,body:SlackEventBody):Promise<'accepted'|'duplicate'|'ignored'> {
 const event=body.event;
 if(body.type!=='event_callback'||!body.event_id||!event||event.type!=='message'||!event.channel)return 'ignored';
 const messageTs=event.subtype==='message_deleted'?event.deleted_ts:event.subtype==='message_changed'||event.subtype==='message_replied'?event.message?.ts:event.ts;
 const eventTs=event.event_ts??event.ts;
 if(!messageTs||!/^\d+\.\d{1,6}$/.test(messageTs)||!eventTs||!/^\d+\.\d{1,6}$/.test(eventTs))return 'ignored';
 return transaction(pool,async c=>{
  const installation=(await c.query(`SELECT s.* FROM slack_connection_state s JOIN source_accounts a ON a.id=s.account_id
   WHERE s.account_id=$1 AND a.provider='slack' AND a.status='active'`,[accountId])).rows[0];
  if(!installation||body.api_app_id!==installation.app_id||body.team_id!==installation.team_id||!body.authorizations?.some(a=>a.team_id===installation.team_id&&a.user_id===installation.authorized_user_id&&a.is_bot===false))return 'ignored';
  const inbox=await c.query(`INSERT INTO slack_event_inbox(account_id,team_id,event_id,envelope_id,event_ts,channel_id,message_ts,payload)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,event_id) DO NOTHING RETURNING id`,[accountId,body.team_id,body.event_id,envelopeId,eventTs,event.channel,messageTs,body]);
  if(!inbox.rowCount)return 'duplicate';
  const stream=`channel:${event.channel}`;
  await c.query('INSERT INTO sync_state(account_id,stream_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[accountId,stream]);
  await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'slack-event',$3,$4)`,[accountId,stream,`slack-event:${inbox.rows[0].id}`,{inboxId:inbox.rows[0].id}]);
  await c.query('UPDATE slack_connection_state SET last_event_received_at=now() WHERE account_id=$1',[accountId]);
  return 'accepted';
 });
}
export async function persistThenAcknowledge(pool:pg.Pool,accountId:string,envelopeId:string,body:SlackEventBody,ack:()=>Promise<void>):Promise<void> {
 await receiveSlackEvent(pool,accountId,envelopeId,body);
 // Ignored unsupported/unauthorized messages are acknowledged without storing content.
 // Accepted/duplicate events reach here only after the database transaction commits.
 await ack();
}
