import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyCapitalOne} from '../packages/connectors/src/verify-capital-one.js';
const env={PLAID_CLIENT_ID:'private-client',PLAID_SECRET:'private-secret',PLAID_ACCESS_TOKEN:'private-access',PLAID_ENV:'production'};
test('Capital One verification requires real production configuration before making requests',async()=>{
 let calls=0;const request:typeof fetch=async()=>{calls++;throw new Error('unexpected network');};
 assert.equal((await verifyCapitalOne({},request)).status,'blocked');assert.equal((await verifyCapitalOne({...env,PLAID_ENV:'sandbox'},request)).status,'blocked');assert.equal(calls,0);
});
test('Capital One production probe returns coverage evidence without account or transaction contents',async()=>{
 const request:typeof fetch=async input=>{
  const path=new URL(String(input)).pathname;
  return Response.json(path==='/item/get'?{item:{institution_id:'private-id'},status:{transactions:{last_successful_update:'2026-10-25T12:00:00Z'}}}:path==='/institutions/get_by_id'?{institution:{name:'Capital One'}}:path==='/accounts/get'?{accounts:[{account_id:'private-account',type:'credit',balances:{current:100}}]}:{added:[{name:'private-merchant'}],modified:[],removed:[]});
 };
 const result=await verifyCapitalOne(env,request);assert.equal(result.status,'verified');assert.ok(!JSON.stringify(result).includes('private-'));assert.ok(JSON.stringify(result).includes('2026-10-25T12:00:00Z'));
});
test('Capital One probe rejects a different institution and redacts provider failures',async()=>{
 const wrong=await verifyCapitalOne(env,async input=>Response.json(String(input).endsWith('/item/get')?{item:{institution_id:'id'}}:{institution:{name:'Other bank'}}));assert.equal(wrong.status,'blocked');
 const failed=await verifyCapitalOne(env,async()=>{throw new Error('private-secret private-access');});assert.equal(failed.status,'blocked');assert.ok(!JSON.stringify(failed).includes('private-'));
});
