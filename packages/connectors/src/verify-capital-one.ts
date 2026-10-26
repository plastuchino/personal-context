export async function verifyCapitalOne(env:NodeJS.ProcessEnv=process.env,request:typeof fetch=fetch) {
 const required=['PLAID_CLIENT_ID','PLAID_SECRET','PLAID_ACCESS_TOKEN','PLAID_ENV'];
 const missing=required.filter(name=>!env[name]);
 if(missing.length)return {status:'blocked' as const,reason:'missing_configuration',missing};
 if(env.PLAID_ENV!=='production')return {status:'blocked' as const,reason:'production_access_required',missing:[]};
 async function call(path:string,input:Record<string,unknown>){
  const response=await request('https://production.plaid.com'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:env.PLAID_CLIENT_ID,secret:env.PLAID_SECRET,...input}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`provider_http_${response.status}`);
  return response.json() as Promise<any>;
 }
 try{
  const auth={access_token:env.PLAID_ACCESS_TOKEN};
  const item=await call('/item/get',auth);
  if(item.item?.error||!item.item?.institution_id)return {status:'blocked' as const,reason:'item_requires_attention',missing:[]};
  const institution=await call('/institutions/get_by_id',{institution_id:item.item.institution_id,country_codes:['US']});
  if(!/^capital\s*one(?:\b|\s)/i.test(institution.institution?.name??''))return {status:'blocked' as const,reason:'capital_one_item_required',missing:[]};
  const accounts=await call('/accounts/get',auth);
  if(!Array.isArray(accounts.accounts)||!accounts.accounts.length)return {status:'blocked' as const,reason:'no_authorized_accounts',missing:[]};
  const transactions=await call('/transactions/sync',{...auth,count:1});
  if(!Array.isArray(transactions.added)||!Array.isArray(transactions.modified)||!Array.isArray(transactions.removed))throw new Error('invalid_provider_response');
  return {status:'verified' as const,provider:'plaid',environment:'production',institution:'Capital One',checkedAt:new Date().toISOString(),
   accountTypes:[...new Set<string>(accounts.accounts.map((a:any)=>String(a.type)))],accountCount:accounts.accounts.length,
   transactionsAccessible:true,upstreamLastSuccessfulUpdate:item.status?.transactions?.last_successful_update??null,
   transactionUpdateStatus:transactions.transactions_update_status??null,
   freshnessGuarantee:'Provider data availability; not a guarantee of new bank data every 15 minutes'};
 }catch(error){
  const message=(error as Error)?.message??'';
  return {status:'blocked' as const,reason:/^provider_http_\d{3}$/.test(message)?message:'provider_verification_failed',missing:[]};
 }
}
if(process.argv[1]?.endsWith('/verify-capital-one.ts')){
 const result=await verifyCapitalOne();console.info(JSON.stringify(result,null,2));if(result.status!=='verified')process.exitCode=2;
}
