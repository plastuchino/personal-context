import { loadConfig } from '@personal-context/config';
import { createPool } from '@personal-context/database';
import { slackAuthorizedGet } from '../../../packages/connectors/src/slack-auth.js';
import { ProviderError } from '../../../packages/connectors/src/http.js';
import { schedule,claim,heartbeat,failJob } from '../../../packages/database/src/jobs.js';
import { processSlackEvent } from '../../../packages/database/src/slack-processing.js';
import { reconcileSlackPage } from '../../../packages/database/src/slack-reconciliation.js';

const config=loadConfig(),pool=createPool(config);
const key=process.env.CREDENTIAL_ENCRYPTION_KEY;
if(!key){await pool.end();throw new Error('CREDENTIAL_ENCRYPTION_KEY is required');}
let running=false,stopped=false;
async function tick(){
 if(running||stopped)return;
 running=true;
 try{
  const accounts=(await pool.query("SELECT id FROM source_accounts WHERE provider='slack' AND status='active'")).rows;
  for(const {id} of accounts)await pool.query("INSERT INTO sync_state(account_id,stream_key) VALUES($1,'discovery') ON CONFLICT DO NOTHING",[id]);
  await schedule(pool,['slack']);
  for(const {id} of accounts){
   const job=await claim(pool,120,{accountId:id,stages:['ingest','slack-event']});if(!job)continue;
   const timer=setInterval(()=>{void heartbeat(pool,job).catch(()=>{});},30000);
   try{
    if(job.stage==='slack-event')await processSlackEvent(pool,job);
    else{
     const get=await slackAuthorizedGet(pool,id,key!,process.env.SLACK_CLIENT_ID,process.env.SLACK_CLIENT_SECRET);
     while(!stopped){if(!await heartbeat(pool,job))throw new Error('Lease lost');if(await reconcileSlackPage(pool,job,get,config.backfillDays))break;}
    }
   }catch(error){
    const code=error instanceof ProviderError?error.code:'slack_processing_failed';
    try{await failJob(pool,job,code,error instanceof ProviderError?error.retryAfterSeconds:undefined);}catch{console.error('Slack job lease lost before failure recording');}
    if(code==='reauthorize')await pool.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[id]);
    await pool.query("UPDATE slack_connection_state SET coverage_complete=false,gap_started_at=coalesce(gap_started_at,now()),error_code=$2 WHERE account_id=$1",[id,code]);
   }finally{clearInterval(timer);}
  }
 }finally{running=false;}
}
const timer=setInterval(()=>{void tick().catch(()=>console.error('Slack processing cycle failed'));},1000);
for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{stopped=true;clearInterval(timer);const wait=setInterval(()=>{if(!running){clearInterval(wait);void pool.end();}},100);});
try{await tick();}catch{console.error('Slack processing startup failed');clearInterval(timer);await pool.end();process.exitCode=1;}
