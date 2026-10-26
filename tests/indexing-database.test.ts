import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../packages/database/src/migrate.js';
import {transaction,upsertRecord} from '../packages/database/src/records.js';
import {indexJob,ensureVectorIndex,embeddingModel,scheduleIndexes} from '../packages/database/src/indexing.js';
import {claim,failJob} from '../packages/database/src/jobs.js';
const url=process.env.TEST_DATABASE_URL;
export const embeddingConfig={endpoint:'http://localhost:11434',model:'fixture',version:'1',dimensions:3,apiKey:undefined};
test('keyword chunks survive embedding outages and derived text preserves historical citation identities',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url}),account=randomUUID();
 try {
  await migrate(db);await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1::uuid,'google-photos',$1::text,'index fixture')",[account]);
  const source={accountId:account,externalId:'receipt',kind:'photo',title:'Receipt',bodyText:'groceries at a local market',rawPayload:{}};const record=await transaction(db,c=>upsertRecord(c,source));
  await scheduleIndexes(db,null,account);let job=(await claim(db,120,{accountId:account,stages:['embed']}))!;assert.ok(job);
  await assert.rejects(indexJob(db,job,{embed:async()=>{throw new Error('disabled');}},null),/embedding_model_unconfigured/);await failJob(db,job,'embedding_model_unconfigured');
  const chunk=(await db.query('SELECT * FROM record_chunks WHERE revision_id=$1',[record.revisionId])).rows[0];assert.ok(chunk.content.includes('groceries'));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM record_chunks WHERE revision_id=$1 AND search_vector @@ plainto_tsquery('english','groceries')",[record.revisionId])).rows[0].n,1);
  await db.query("UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
  await db.query("INSERT INTO derived_content(revision_id,kind,text,model_version) VALUES($1,'ocr','MARKET TOTAL 12.00','vision@1')",[record.revisionId]);
  const model=await ensureVectorIndex(db,embeddingConfig);await scheduleIndexes(db,embeddingConfig,account);job=(await claim(db,120,{accountId:account,stages:['embed']}))!;
  await indexJob(db,job,{embed:async texts=>texts.map(()=>[1,0,0])},embeddingConfig);
  assert.equal((await db.query('SELECT content FROM record_chunks WHERE id=$1',[chunk.id])).rows[0].content,chunk.content);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM chunk_embeddings WHERE embedding_model_id=$1',[model])).rows[0].n,2);
  const derived=(await db.query("SELECT c.*,s.content AS source_content FROM record_chunks c JOIN index_sources s ON s.id=c.source_id WHERE c.revision_id=$1 AND s.kind='ocr'",[record.revisionId])).rows[0];assert.equal(derived.content,derived.source_content.slice(derived.start_offset,derived.end_offset));
  await assert.rejects(embeddingModel(db,{...embeddingConfig,dimensions:4}),/dimension mismatch/);
  const edited=await transaction(db,c=>upsertRecord(c,{...source,bodyText:'edited source'}));assert.notEqual(edited.revisionId,record.revisionId);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM record_chunks c JOIN records r ON r.current_revision_id=c.revision_id WHERE r.id=$1',[record.recordId])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM record_chunks WHERE id=$1',[chunk.id])).rows[0].n,1);
 }finally{await db.query("UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL WHERE account_id=$1 AND status IN ('queued','running')",[account]);await db.end();}
});
