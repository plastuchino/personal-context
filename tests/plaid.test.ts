import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'lossless-json';
import {plaidClient,plaidBatch,financialTransactionRecord} from '../packages/connectors/src/plaid.js';
import {ProviderError} from '../packages/connectors/src/http.js';
test('Plaid preserves exact amount literals and source JSON beyond JS integer precision',()=>{
 const tx=parse('{"transaction_id":"t","account_id":"a","amount":12345678901234567890.12,"iso_currency_code":"USD","pending":false}') as any;
 const record=financialTransactionRecord('source',tx);assert.equal(record.financial?.amount,'12345678901234567890.12');assert.ok(record.rawJson?.includes('12345678901234567890.12'));
});
test('Plaid retries a mutation from the stable cursor and discards partial pages',async()=>{
 const cursors:unknown[]=[];let mutation=true;
 const result=await plaidBatch(async(path,input)=>{
  if(path==='/accounts/get')return {accounts:[]};if(path==='/item/get')return {status:{}};
  cursors.push(input.cursor);
  if(input.cursor==='stable')return {added:[],modified:[],removed:[],has_more:true,next_cursor:'page'};
  if(mutation){mutation=false;throw new ProviderError('pagination_restart',400);}
  return {added:[],modified:[],removed:[{transaction_id:'removed'}],has_more:false,next_cursor:'done'};
 },'a','access','stable');
 assert.deepEqual(cursors,['stable','page','stable','page']);assert.equal(result.cursor,'done');assert.equal(result.records[0].deleted,true);
});
test('Plaid Sandbox host is explicit, errors are redacted, and NOT_READY is not successful coverage',async()=>{
 const client=plaidClient({environment:'sandbox',clientId:'client',secret:'secret'},async input=>{assert.equal(new URL(String(input)).hostname,'sandbox.plaid.com');return new Response(JSON.stringify({error_code:'ITEM_LOGIN_REQUIRED',error_message:'private'}),{status:400});});
 await assert.rejects(client('/item/get',{}),/reauthorize/);
 await assert.rejects(plaidBatch(async path=>path==='/accounts/get'?{accounts:[]}:{transactions_update_status:'NOT_READY'},'a','token',null),/source_not_ready/);
});
