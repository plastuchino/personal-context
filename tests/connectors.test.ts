import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmailPage,gmailRecord } from '../packages/connectors/src/gmail.js';
import { ProviderError,providerGet } from '../packages/connectors/src/http.js';
const message={id:'m1',threadId:'t1',internalDate:'1792929600000',labelIds:['SENT'],payload:{headers:[{name:'From',value:'Me <me@example.test>'},{name:'To',value:'them@example.test'},{name:'In-Reply-To',value:'<original>'}],body:{data:Buffer.from('reply body').toString('base64url')}}};
test('provider errors distinguish Google quota failures without retaining source content',async()=>{
 for(const [status,reason,code]of [[403,'userRateLimitExceeded','rate_limited'],[403,'dailyLimitExceeded','provider_daily_quota'],[403,'domainPolicy','provider_domain_policy'],[403,'private arbitrary reason','provider_http_403'],[503,'backendError','provider_http_503'],[401,'authError','reauthorize'],[429,'quota','rate_limited']]as const){
  const get=providerGet('https://gmail.googleapis.com/gmail/v1/users/me','test-token',async()=>Response.json({error:{message:'private message',errors:[{reason}]}},{status,headers:{'Retry-After':'120'}}));
  await assert.rejects(get('/messages'),error=>error instanceof ProviderError&&error.code===code&&error.status===status&&error.retryAfterSeconds===120&&!error.message.includes('private'));
 }
 const get=providerGet('https://gmail.googleapis.com','test-token',async()=>new Response('unparseable private body',{status:403}));
 await assert.rejects(get('/'),error=>error instanceof ProviderError&&error.code==='provider_http_403');
});
test('Gmail captures owner identity, reply relationships, and body',()=>{
 const record=gmailRecord('account',message,'me@example.test');
 assert.equal(record.bodyText,'reply body');assert.equal(record.email?.inReplyTo,'<original>');assert.equal(record.participants?.find(p=>p.role==='sender')?.isSelf,true);
});
test('Gmail pagination retains initial history anchor and resets expired history',async()=>{
 const get=async(path:string)=>path==='/profile'?{historyId:'100',emailAddress:'me@example.test'}:path==='/messages'?{messages:[{id:'m1'}],nextPageToken:'page2'}:message;
 const page=await gmailPage(get,'account',null,30);assert.equal(page.complete,false);assert.equal((page.cursor as any).anchor,'100');
 const state={phase:'history' as const,anchor:'100',since:0,selfEmail:'me@example.test'};
 const reset=await gmailPage(async()=>{throw new ProviderError('provider_error',404);},'account',state,30);assert.equal(reset.reset,true);assert.equal(reset.cursor,null);
});
test('Gmail history processes deletes without fetching deleted content',async()=>{
 const result=await gmailPage(async()=>({historyId:'200',history:[{messagesDeleted:[{message:{id:'m1'}}]}]}),'account',{phase:'history',anchor:'100',since:0,selfEmail:'me@example.test'},30);
 assert.equal(result.records[0].deleted,true);assert.equal((result.cursor as any).anchor,'200');
});
