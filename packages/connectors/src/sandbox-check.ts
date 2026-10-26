import {loadConfig} from '@personal-context/config';
import {createPool} from '@personal-context/database';
import {plaidClient,plaidBatch} from './plaid.js';
import {connectFinancialItem} from '../../database/src/financial-connection.js';
import {schedule,claim,commitPage,failJob} from '../../database/src/jobs.js';
import {ProviderError} from './http.js';

async function main(){
 if(process.env.PLAID_ENV!=='sandbox')throw new Error('Sandbox-only command');
 const {PLAID_CLIENT_ID,PLAID_SECRET,PLAID_ACCESS_TOKEN,CREDENTIAL_ENCRYPTION_KEY}=process.env;
 if(!PLAID_CLIENT_ID||!PLAID_SECRET||!PLAID_ACCESS_TOKEN||!CREDENTIAL_ENCRYPTION_KEY)throw new Error('Sandbox configuration incomplete');
 const config={environment:'sandbox' as const,clientId:PLAID_CLIENT_ID,secret:PLAID_SECRET};
 const call=plaidClient(config),pool=createPool(loadConfig());
 try{
  const sourceId=await connectFinancialItem(pool,call,config,PLAID_ACCESS_TOKEN,CREDENTIAL_ENCRYPTION_KEY);
  await schedule(pool,['capital-one']);
  const job=await claim(pool,120,{accountId:sourceId,stages:['ingest']});
  if(!job){console.info(JSON.stringify({status:'not_due',environment:'sandbox',productionVerified:false}));return;}
  try{
   const cursor=(await pool.query('SELECT cursor FROM sync_state WHERE account_id=$1 AND stream_key=$2',[sourceId,job.stream_key])).rows[0].cursor;
   const page=await plaidBatch(call,sourceId,PLAID_ACCESS_TOKEN,cursor,loadConfig().backfillDays);
   await commitPage(pool,job,page);
   console.info(JSON.stringify({status:'verified_sandbox',environment:'sandbox',simulatedData:true,sourceId,accountRecords:page.records.filter(r=>r.kind==='financial-account').length,transactionRecords:page.records.filter(r=>r.kind==='financial-transaction').length,productionVerified:false}));
  }catch(error){
   const code=error instanceof ProviderError?error.code:'sandbox_ingestion_failed';
   await failJob(pool,job,code,error instanceof ProviderError?error.retryAfterSeconds:undefined);throw new Error(code);
  }
 }finally{await pool.end();}
}
try{await main();}catch(error){const code=(error as Error).message;console.info(JSON.stringify({status:'failed',environment:'sandbox',code:/^[a-z_]+$/.test(code)?code:'sandbox_check_failed'}));process.exitCode=2;}
