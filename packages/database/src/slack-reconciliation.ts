import type pg from 'pg';
import { transaction } from './records.js';
import { commitPage, fence, type Job } from './jobs.js';
import { slackConversations, slackReconciliationPage, type SlackReconcileCursor } from '../../connectors/src/slack.js';
import type { ProviderGet } from '../../connectors/src/http.js';

export async function reconcileSlackPage(pool:pg.Pool,job:Job,get:ProviderGet,backfillDays:number):Promise<boolean> {
 const row=(await pool.query('SELECT cursor FROM sync_state WHERE account_id=$1 AND stream_key=$2',[job.account_id,job.stream_key])).rows[0];
 if(!row)throw new Error('Missing Slack stream');
 if(job.stream_key==='discovery'){
  const page=await slackConversations(get,row.cursor?.page);
  await transaction(pool,async c=>{
   await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
   for(const channel of page.conversations){
    const kind=channel.is_im?'direct':channel.is_mpim?'group':'channel';
    await c.query(`INSERT INTO conversations(account_id,external_id,kind,title) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,external_id) DO UPDATE SET kind=excluded.kind,title=excluded.title`,[job.account_id,channel.id,kind,channel.name??channel.id]);
    await c.query('INSERT INTO sync_state(account_id,stream_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.account_id,`channel:${channel.id}`]);
   }
   await c.query('UPDATE sync_state SET cursor=$3,last_success_at=CASE WHEN $4 THEN now() ELSE last_success_at END WHERE account_id=$1 AND stream_key=$2',[job.account_id,job.stream_key,page.nextCursor?{page:page.nextCursor}:null,!page.nextCursor]);
   if(!page.nextCursor)await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
  });
  return !page.nextCursor;
 }
 const channelId=job.stream_key.replace(/^channel:/,'');
 const installation=(await pool.query('SELECT authorized_user_id FROM slack_connection_state WHERE account_id=$1',[job.account_id])).rows[0];
 if(!installation)throw new Error('Slack installation unavailable');
 const channel=(await pool.query('SELECT kind,title FROM conversations WHERE account_id=$1 AND external_id=$2',[job.account_id,channelId])).rows[0];
 const tracked=(await pool.query('SELECT thread_ts FROM slack_threads WHERE account_id=$1 AND channel_id=$2 ORDER BY thread_ts',[job.account_id,channelId])).rows.map(x=>x.thread_ts);
 const page=await slackReconciliationPage(get,job.account_id,{id:channelId,name:channel?.title??channelId,is_im:channel?.kind==='direct',is_mpim:channel?.kind==='group'},installation.authorized_user_id,backfillDays,tracked,row.cursor as SlackReconcileCursor|null);
 await commitPage(pool,job,page);
 if(page.complete){
  await pool.query('UPDATE slack_threads SET last_reconciled_at=now() WHERE account_id=$1 AND channel_id=$2',[job.account_id,channelId]);
  // A successful sweep records progress, but cannot prove recovery of every edit or
  // deletion during a delivery outage. Retain gap evidence rather than invent coverage.
  await pool.query(`UPDATE slack_connection_state SET last_reconciled_at=now(),coverage_complete=(gap_started_at IS NULL AND
   NOT EXISTS(SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key LIKE 'channel:%' AND NOT coverage_complete)) WHERE account_id=$1`,[job.account_id]);
 }
 return page.complete;
}
