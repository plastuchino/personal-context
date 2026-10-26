import {parse,stringify,isLosslessNumber} from 'lossless-json';
import type {SourceRecord} from '../../database/src/records.js';
import {ProviderError} from './http.js';
export interface PlaidConfig {environment:'sandbox'|'production';clientId:string;secret:string}
export type PlaidCall=(path:string,input:Record<string,unknown>)=>Promise<any>;
export function plaidClient(config:PlaidConfig,request:typeof fetch=fetch):PlaidCall {
 if(!['sandbox','production'].includes(config.environment)||!config.clientId||!config.secret)throw new Error('Plaid configuration is incomplete');
 const allowed=new Set(['/accounts/get','/transactions/sync','/item/get','/institutions/get_by_id','/link/token/create','/item/public_token/exchange','/sandbox/public_token/create']);
 return async(path,input)=>{
  if(!allowed.has(path)||(path.startsWith('/sandbox/')&&config.environment!=='sandbox'))throw new Error('Unsupported Plaid operation');
  const response=await request(`https://${config.environment}.plaid.com${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:config.clientId,secret:config.secret,...input}),signal:AbortSignal.timeout(30000)});
  const data:any=parse(await response.text());
  if(!response.ok){
   const code=data.error_code;
   throw new ProviderError(code==='TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'?'pagination_restart':code==='PRODUCT_NOT_READY'?'source_not_ready':code==='ITEM_LOGIN_REQUIRED'?'reauthorize':response.status===429?'rate_limited':'provider_error',response.status,response.status===429?60:undefined);
  }
  return data;
 };
}
function money(value:unknown):string|null {
 if(value===null||value===undefined)return null;
 const literal=isLosslessNumber(value)?value.toString():typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):null;
 if(!literal||!/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(literal))throw new Error('Financial values require exact decimal literals');
 return literal;
}
export function financialAccountRecord(sourceId:string,account:any,observedAt:string):SourceRecord {
 const balance=money(account.balances?.current);
 const currency=account.balances?.iso_currency_code??account.balances?.unofficial_currency_code??null;
 return {accountId:sourceId,externalId:account.account_id,kind:'financial-account',title:account.name??account.type,
  bodyText:JSON.stringify({name:account.name??null,type:account.type,currentBalance:balance,currency}),rawPayload:{},rawJson:stringify(account)!,
  financialAccount:{externalId:account.account_id,type:account.type,currency,balance,observedAt}};
}
export function financialTransactionRecord(sourceId:string,tx:any):SourceRecord {
 const amount=money(tx.amount);if(amount===null)throw new Error('Transaction amount missing');
 const currency=tx.iso_currency_code??tx.unofficial_currency_code;if(!currency)throw new Error('Transaction currency missing');
 return {accountId:sourceId,externalId:tx.transaction_id,kind:'financial-transaction',title:tx.merchant_name??tx.name??'Transaction',
  bodyText:JSON.stringify({name:tx.name??null,merchant:tx.merchant_name??null,amount,currency,date:tx.date??null,pending:!!tx.pending}),rawPayload:{},rawJson:stringify(tx)!,
  sourceCreatedAt:tx.datetime??null,financial:{externalAccountId:tx.account_id,amount,currency,merchant:tx.merchant_name??null,pending:!!tx.pending,pendingExternalId:tx.pending_transaction_id??null,postedDate:tx.date??null}};
}
export async function plaidBatch(call:PlaidCall,sourceId:string,accessToken:string,cursor:string|null,backfillDays=30,now=new Date()):Promise<{records:SourceRecord[];cursor:string;complete:true;watermark?:string;coverageStart:string;coverageEnd:string;coverageComplete:true}> {
 const auth={access_token:accessToken};
 const accountData=await call('/accounts/get',auth);
 const since=new Date(now.getTime()-backfillDays*86400000).toISOString();
 // No database checkpoint advances until the complete provider pagination batch is available.
 for(let restart=0;restart<3;restart++){
  const records:SourceRecord[]=(accountData.accounts??[]).map((a:any)=>financialAccountRecord(sourceId,a,now.toISOString()));
  let next=cursor;
  try{
   for(;;){
    const data=await call('/transactions/sync',{...auth,...(next?{cursor:next}:{}),count:100});
    if(data.transactions_update_status==='NOT_READY')throw new ProviderError('source_not_ready',425,30);
    for(const tx of data.added??[])if(cursor||!tx.date||tx.date>=since.slice(0,10))records.push(financialTransactionRecord(sourceId,tx));
    for(const tx of data.modified??[])records.push(financialTransactionRecord(sourceId,tx));
    for(const tx of data.removed??[])records.push({accountId:sourceId,externalId:tx.transaction_id,kind:'financial-transaction',bodyText:'',rawPayload:tx,deleted:true});
    if(typeof data.next_cursor!=='string')throw new Error('Plaid cursor missing');next=data.next_cursor;
    if(!data.has_more)break;
   }
   const item=await call('/item/get',auth);
   const watermark=item.status?.transactions?.last_successful_update;
   return {records,cursor:next!,complete:true,watermark:typeof watermark==='string'?watermark:undefined,coverageStart:since,coverageEnd:now.toISOString(),coverageComplete:true};
  }catch(error){if(!(error instanceof ProviderError&&error.code==='pagination_restart')||restart===2)throw error;}
 }
 throw new Error('Unreachable pagination state');
}
