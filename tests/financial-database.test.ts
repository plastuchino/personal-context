import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {parse} from 'lossless-json';
import {migrate} from '../packages/database/src/migrate.js';
import {transaction,upsertRecord} from '../packages/database/src/records.js';
import {financialAccountRecord,financialTransactionRecord} from '../packages/connectors/src/plaid.js';
const url=process.env.TEST_DATABASE_URL;
test('financial ingestion preserves exact source decimals, replay, replacements and removals',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const source=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,provider_environment) VALUES($1,'capital-one',$2,'Sandbox','sandbox')",[source,source]);
  const account=parse('{"account_id":"bank","type":"credit","balances":{"current":12345678901234567890.12,"iso_currency_code":"USD"}}');
  await transaction(db,c=>upsertRecord(c,financialAccountRecord(source,account,new Date().toISOString())));
  const pending=parse('{"transaction_id":"pending","account_id":"bank","amount":12.34,"iso_currency_code":"USD","pending":true,"date":"2026-10-25"}');
  const before=await transaction(db,c=>upsertRecord(c,financialTransactionRecord(source,pending)));
  const again=await transaction(db,c=>upsertRecord(c,financialTransactionRecord(source,pending)));assert.equal(before.revisionId,again.revisionId);
  const posted=parse('{"transaction_id":"posted","account_id":"bank","amount":12345678901234567890.12,"iso_currency_code":"USD","pending":false,"pending_transaction_id":"pending","date":"2026-10-25"}');
  const after=await transaction(db,c=>upsertRecord(c,financialTransactionRecord(source,posted)));
  const detail=(await db.query('SELECT amount FROM financial_transaction_details WHERE record_id=$1',[after.recordId])).rows[0];assert.equal(detail.amount,'12345678901234567890.12');
  assert.equal((await db.query("SELECT raw_payload->>'amount' AS amount FROM record_revisions WHERE id=$1",[after.revisionId])).rows[0].amount,'12345678901234567890.12');
  await transaction(db,c=>upsertRecord(c,financialTransactionRecord(source,pending)));
  assert.ok((await db.query('SELECT deleted_at FROM records WHERE id=$1',[before.recordId])).rows[0].deleted_at);
  await transaction(db,c=>upsertRecord(c,{accountId:source,externalId:'posted',kind:'financial-transaction',bodyText:'',rawPayload:{},deleted:true}));
  assert.ok((await db.query('SELECT deleted_at FROM records WHERE id=$1',[after.recordId])).rows[0].deleted_at);
 }finally{await db.end();}
});
