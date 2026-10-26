import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../packages/database/src/migrate.js';
import {initializeStreams,ingestStep,type IngestionAccess} from '../packages/database/src/ingestion.js';
import {schedule,claim,failJob} from '../packages/database/src/jobs.js';
import {ProviderError} from '../packages/connectors/src/http.js';
const url=process.env.TEST_DATABASE_URL;
test('four providers schedule independently and persist real ingestion contracts with distinct freshness',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const sources=new Map<string,string>();
  for(const provider of ['gmail','slack','calendar','capital-one']){
   const id=randomUUID();sources.set(provider,id);
   await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status,provider_environment) VALUES($1,$2,$3,'fixture','active','sandbox')",[id,provider,id]);
   if(provider==='slack')await db.query("INSERT INTO slack_connection_state(account_id,app_id,team_id,authorized_user_id) VALUES($1,$2,$3,'SELF')",[id,id,id]);
  }
  const accessFor=(provider:string):IngestionAccess=>({
   google:async(path,params)=>{
    if(provider==='gmail')return path==='/profile'?{historyId:'anchor',emailAddress:'me@example.test'}:path==='/messages'?{messages:[{id:'mail'}]}:{id:'mail',threadId:'thread',payload:{headers:[],body:{data:Buffer.from('hello').toString('base64url')}}};
    if(path==='/users/me/calendarList')return {items:[{id:'calendar'}]};
    return {items:[{id:'event',start:{date:'2026-10-25'},end:{date:'2026-10-26'}}],...(params?.singleEvents==='false'?{nextSyncToken:'token'}:{})};
   },
   slack:async path=>path==='/conversations.list'?{ok:true,channels:[{id:'C1'}]}:{ok:true,messages:[{ts:'1792929600.000001',user:'SELF',text:'hello'}]},
   financialAccessToken:'fixture-access',financial:async path=>path==='/accounts/get'?{accounts:[{account_id:'bank',type:'credit',balances:{current:'10.00',iso_currency_code:'USD'}}]}:path==='/item/get'?{status:{transactions:{last_successful_update:'2026-10-20T12:00:00Z'}}}:{added:[{transaction_id:'tx',account_id:'bank',amount:'12.34',iso_currency_code:'USD',pending:false,date:'2026-10-25'}],modified:[],removed:[],next_cursor:'cursor',has_more:false},
  });
  await initializeStreams(db);
  for(let round=0;round<2;round++){
   await schedule(db);
   for(const [provider,id]of sources){
    const job=await claim(db,120,{accountId:id,stages:['ingest']});if(!job)continue;
    while(!await ingestStep(db,job,{backfillDays:30,calendarFutureDays:90},accessFor(provider))){}
   }
  }
  for(const [provider,id]of sources)assert.ok((await db.query('SELECT count(*)::int AS n FROM records WHERE account_id=$1',[id])).rows[0].n>=1,provider);
  const bank=(await db.query('SELECT last_success_at,source_watermark_at,next_check_at FROM sync_state WHERE account_id=$1',[sources.get('capital-one')])).rows[0];
  assert.equal(bank.source_watermark_at.toISOString(),'2026-10-20T12:00:00.000Z');assert.ok(bank.last_success_at.getTime()>bank.source_watermark_at.getTime());assert.ok(bank.next_check_at.getTime()>Date.now()+14*60000);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE account_id=ANY($1::uuid[]) AND stage='embed'",[[...sources.values()]])).rows[0].n,5);
  const gmail=sources.get('gmail')!;await db.query("UPDATE sync_state SET next_check_at=now() WHERE account_id=$1",[gmail]);await schedule(db);
  const failed=await claim(db,120,{accountId:gmail,stages:['ingest']});assert.ok(failed);
  await failJob(db,failed,'rate_limited',120);
  const calendar=sources.get('calendar')!;await db.query("UPDATE sync_state SET next_check_at=now() WHERE account_id=$1 AND stream_key='discovery'",[calendar]);await schedule(db);
  const independent=await claim(db,120,{accountId:calendar,stages:['ingest']});assert.ok(independent);assert.equal(await ingestStep(db,independent,{backfillDays:30,calendarFutureDays:90},accessFor('calendar')),true);
  await db.query('UPDATE sync_state SET enabled=false,next_check_at=now() WHERE account_id=$1',[calendar]);await schedule(db);
  assert.equal(await claim(db,120,{accountId:calendar,stages:['ingest']}),null);
 }finally{await db.end();}
});
