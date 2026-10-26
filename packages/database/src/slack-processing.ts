import type pg from 'pg';
import { transaction, upsertRecord, type SourceRecord } from './records.js';
import { fence, queueDerived, type Job } from './jobs.js';
import { slackRecord, type SlackConversation, type SlackMessage } from '../../connectors/src/slack.js';
import type { SlackEventBody } from './slack-events.js';

export async function processSlackEvent(pool:pg.Pool,job:Job):Promise<void> {
 if(job.stage!=='slack-event')throw new Error('Wrong job stage');
 const inboxId=(job.payload as {inboxId?:string})?.inboxId;
 if(!inboxId)throw new Error('Missing inbox reference');
 await transaction(pool,async c=>{
  await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);
  await fence(c,job);
  const row=(await c.query(`SELECT i.*,s.authorized_user_id FROM slack_event_inbox i JOIN slack_connection_state s USING(account_id)
   WHERE i.id=$1 AND i.account_id=$2 FOR UPDATE OF i`,[inboxId,job.account_id])).rows[0];
  if(!row)throw new Error('Inbox account mismatch');
  if(row.status!=='done'){
   const body=row.payload as SlackEventBody,event=body.event!;
   const existing=(await c.query('SELECT kind,title FROM conversations WHERE account_id=$1 AND external_id=$2',[job.account_id,row.channel_id])).rows[0];
   const channel:SlackConversation={id:row.channel_id,name:existing?.title??row.channel_id,is_im:existing?.kind==='direct',is_mpim:existing?.kind==='group'};
   let source:SourceRecord;
   if(event.subtype==='message_deleted')source={accountId:job.account_id,externalId:`${row.channel_id}:${row.message_ts}`,kind:'slack-message',bodyText:'',rawPayload:body,deleted:true,slack:{channelId:row.channel_id,messageTs:row.message_ts,threadTs:null,version:row.event_ts}};
   else{
    const message=(event.subtype==='message_changed'||event.subtype==='message_replied'?event.message:event) as SlackMessage;
    source=slackRecord(job.account_id,channel,message,row.authorized_user_id);
    // Creation/redelivery versions use message.ts; edits use the source edit timestamp.
    // message_replied is parent metadata and must not advance a parent's content version.
    source.slack!.version=event.subtype==='message_changed'?(message.edited?.ts??row.event_ts):(message.edited?.ts??message.ts);
   }
   const stored=await upsertRecord(c,source);
   if(stored.changed){
    if(stored.revisionId&&!source.deleted)await queueDerived(c,job.account_id,stored.recordId,stored.revisionId);
    await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'reclassify',$3,$4) ON CONFLICT DO NOTHING`,[job.account_id,job.stream_key,`slack-context:${row.id}`,{recordId:stored.recordId,channelId:row.channel_id}]);
   }
   await c.query("UPDATE slack_event_inbox SET status='done',processed_at=now() WHERE id=$1",[row.id]);
   await c.query('UPDATE slack_connection_state SET last_event_processed_at=now() WHERE account_id=$1',[job.account_id]);
  }
  await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
 });
}
