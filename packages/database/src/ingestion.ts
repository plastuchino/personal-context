import type pg from 'pg';
import type {Config} from '@personal-context/config';
import {readCredential} from './credentials.js';
import {transaction} from './records.js';
import {commitPage,fence,type Job} from './jobs.js';
import {gmailPage,type GmailCursor} from '../../connectors/src/gmail.js';
import {calendarListPage,calendarPage,type CalendarCursor} from '../../connectors/src/calendar.js';
import {googleAuthorizedGet} from '../../connectors/src/google-auth.js';
import {slackAuthorizedGet} from '../../connectors/src/slack-auth.js';
import {plaidClient,plaidBatch,type PlaidCall} from '../../connectors/src/plaid.js';
import {ProviderError,type ProviderGet} from '../../connectors/src/http.js';
import {reconcileSlackPage} from './slack-reconciliation.js';
import {processSlackEvent} from './slack-processing.js';

export async function initializeStreams(pool:pg.Pool):Promise<void>{
 await pool.query(`INSERT INTO sync_state(account_id,stream_key)
  SELECT id,CASE provider WHEN 'gmail' THEN 'mailbox' WHEN 'capital-one' THEN 'transactions' ELSE 'discovery' END
  FROM source_accounts WHERE status='active' AND provider IN ('gmail','calendar','slack','capital-one') ON CONFLICT DO NOTHING`);
}
export interface IngestionAccess {
 key?:string;googleClientId?:string;googleClientSecret?:string;slackClientId?:string;slackClientSecret?:string;
 plaid?:{environment:'sandbox'|'production';clientId:string;secret:string};
 google?:ProviderGet;slack?:ProviderGet;financial?:PlaidCall;financialAccessToken?:string;
}
export async function ingestStep(pool:pg.Pool,job:Job,config:Pick<Config,'backfillDays'|'calendarFutureDays'>,access:IngestionAccess):Promise<boolean>{
 const source=(await pool.query('SELECT provider,status,provider_environment FROM source_accounts WHERE id=$1',[job.account_id])).rows[0];
 if(!source||source.status!=='active')throw new ProviderError('source_disabled',403);
 if(job.stage==='slack-event'){await processSlackEvent(pool,job);return true;}
 if(job.stage!=='ingest')throw new Error('Unsupported ingestion stage');
 const state=(await pool.query('SELECT cursor FROM sync_state WHERE account_id=$1 AND stream_key=$2 AND enabled',[job.account_id,job.stream_key])).rows[0];
 if(!state)throw new ProviderError('stream_disabled',403);
 if(source.provider==='slack'){
  const get=access.slack??await slackAuthorizedGet(pool,job.account_id,access.key!,access.slackClientId,access.slackClientSecret);
  return reconcileSlackPage(pool,job,get,config.backfillDays);
 }
 if(source.provider==='capital-one'){
  const credential=access.financialAccessToken?{access_token:access.financialAccessToken,environment:source.provider_environment}:JSON.parse(await readCredential(pool,job.account_id,access.key!));
  if(!access.financial&&(!access.plaid||access.plaid.environment!==source.provider_environment||credential.environment!==source.provider_environment))throw new ProviderError('provider_environment_mismatch',400);
  const call=access.financial??plaidClient(access.plaid!);
  const page=await plaidBatch(call,job.account_id,credential.access_token,state.cursor,config.backfillDays);await commitPage(pool,job,page);return true;
 }
 const base=source.provider==='gmail'?'https://gmail.googleapis.com/gmail/v1/users/me':source.provider==='calendar'?'https://www.googleapis.com/calendar/v3':null;
 if(!base)throw new Error('Unsupported scheduled source');
 const get=access.google??await googleAuthorizedGet(pool,job.account_id,base,access.key!,access.googleClientId,access.googleClientSecret);
 if(source.provider==='gmail'){
  const page=await gmailPage(get,job.account_id,state.cursor as GmailCursor|null,config.backfillDays);await commitPage(pool,job,page);return page.complete;
 }
 if(job.stream_key==='discovery'){
  const page=await calendarListPage(get,state.cursor?.page);
  await transaction(pool,async c=>{
   await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
   for(const calendar of page.calendars){
    await c.query(`INSERT INTO sync_state(account_id,stream_key,enabled) VALUES($1,$2,$3) ON CONFLICT(account_id,stream_key) DO UPDATE SET enabled=excluded.enabled`,[job.account_id,`calendar:${calendar.id}`,!calendar.deleted]);
   }
   await c.query('UPDATE sync_state SET cursor=$3,last_success_at=CASE WHEN $4 THEN now() ELSE last_success_at END WHERE account_id=$1 AND stream_key=$2',[job.account_id,job.stream_key,page.nextPageToken?{page:page.nextPageToken}:null,!page.nextPageToken]);
   if(!page.nextPageToken)await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_until=NULL,lease_token=NULL WHERE id=$1",[job.id]);
  });return !page.nextPageToken;
 }
 const calendarId=job.stream_key.replace(/^calendar:/,'');
 const page=await calendarPage(get,job.account_id,calendarId,state.cursor as CalendarCursor|null,config.backfillDays,config.calendarFutureDays);
 await commitPage(pool,job,page);return page.complete;
}
