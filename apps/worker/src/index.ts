import {resumeConfiguredPhotoAnalysis} from '../../../packages/database/src/model-recovery.js';
import {indexJob,scheduleIndexes,ensureVectorIndex} from '../../../packages/database/src/indexing.js';
import {classifyJob} from '../../../packages/database/src/classification.js';
import {scheduleClassifications,processReclassification} from '../../../packages/database/src/classification-scheduling.js';
import {createModelAdapters} from '@personal-context/models';
import {photoClient} from '../../../packages/connectors/src/photos.js';
import {googleAccessToken} from '../../../packages/connectors/src/google-auth.js';
import {selectionStep} from '../../../packages/database/src/photo-imports.js';
import {downloadPhoto} from '../../../packages/database/src/photo-media.js';
import {analyzePhoto,recordPhotoFailure} from '../../../packages/database/src/photo-analysis.js';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '@personal-context/config';
import {createPool} from '@personal-context/database';
import {credentialCipher} from '@personal-context/security';
import {initializeStreams,ingestStep,type IngestionAccess} from '../../../packages/database/src/ingestion.js';
import {schedule,claim,heartbeat,failJob} from '../../../packages/database/src/jobs.js';
import {ProviderError} from '../../../packages/connectors/src/http.js';
const config=loadConfig(),key=process.env.CREDENTIAL_ENCRYPTION_KEY;
if(!key)throw new Error('CREDENTIAL_ENCRYPTION_KEY is required for ingestion');
credentialCipher(key);
const pool=createPool(config),stop=new AbortController(),models=createModelAdapters(config);
const classifierVersion=config.classifier?`${config.classifier.adapter??'gateway'}:${config.classifier.model}@${config.classifier.version}`:null;
const mode=process.env.PLAID_ENV;
const access:IngestionAccess={key,googleClientId:process.env.GOOGLE_CLIENT_ID,googleClientSecret:process.env.GOOGLE_CLIENT_SECRET,slackClientId:process.env.SLACK_CLIENT_ID,slackClientSecret:process.env.SLACK_CLIENT_SECRET,
 plaid:mode==='sandbox'||mode==='production'?{environment:mode,clientId:process.env.PLAID_CLIENT_ID??'',secret:process.env.PLAID_SECRET??''}:undefined};
let scheduling=false;
async function due(){if(scheduling||stop.signal.aborted)return;scheduling=true;try{await initializeStreams(pool);await schedule(pool);if(config.vision)await resumeConfiguredPhotoAnalysis(pool);await scheduleIndexes(pool,config.embedding);if(classifierVersion)await scheduleClassifications(pool,classifierVersion);}finally{scheduling=false;}}
const timer=setInterval(()=>{void due().catch(()=>console.error('Ingestion scheduling failed'));},15000);
for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{clearInterval(timer);stop.abort();});
async function loop(stages:string[]){
 while(!stop.signal.aborted){
  const job=await claim(pool,120,{stages});
  if(!job){try{await delay(1000,undefined,{signal:stop.signal});}catch{}continue;}
  const renew=setInterval(()=>{void heartbeat(pool,job).catch(()=>{});},30000);
  try{
   while(!stop.signal.aborted){if(!await heartbeat(pool,job))throw new Error('Lease lost');if(job.stage==='embed'){await indexJob(pool,job,models,config.embedding);break;}else if(job.stage==='classify'){await classifyJob(pool,job,models,classifierVersion!);break;}else if(job.stage==='reclassify'){await processReclassification(pool,job,classifierVersion!);break;}else if(job.stage==='photo'){
    if(!(await pool.query("SELECT 1 FROM source_accounts WHERE id=$1 AND provider='google-photos' AND status='active'",[job.account_id])).rowCount)throw new ProviderError('reauthorize',401);
    const client=photoClient(()=>googleAccessToken(pool,job.account_id,key!,access.googleClientId,access.googleClientSecret));
    const action=(job.payload as {action:string}).action;
    if(action==='poll'||action==='import'){if(await selectionStep(pool,job,client))break;}
    else if(action==='download'){await downloadPhoto(pool,job,client,config.maxMediaBytes);break;}
    else if(action==='analyze'){await analyzePhoto(pool,job,models,config.vision?`${config.vision.model}@${config.vision.version}`:null);break;}
    else throw new Error('Unsupported photo action');
   }else if(await ingestStep(pool,job,config,access))break;}
  }catch(error){
   const code=error instanceof ProviderError?error.code:job.stage==='embed'?'embedding_failed':'ingestion_failed';
   try{await failJob(pool,job,code,error instanceof ProviderError?error.retryAfterSeconds:undefined);}catch{console.error('Ingestion lease lost before failure recording');}
   if(job.stage==='photo')await recordPhotoFailure(pool,job,code);
   if(code==='reauthorize')await pool.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[job.account_id]);
  }finally{clearInterval(renew);}
 }
}
try{if(config.embedding)await ensureVectorIndex(pool,config.embedding);await due();await Promise.all([loop(['ingest','slack-event','reclassify']),loop(['ingest','slack-event','reclassify']),loop(['photo']),loop(['embed',...(classifierVersion?['classify']:[])])]);}catch{console.error('Ingestion worker stopped after service failure');process.exitCode=1;stop.abort();}finally{clearInterval(timer);while(scheduling)await delay(10);await pool.end();}
