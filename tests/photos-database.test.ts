import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../packages/database/src/migrate.js';
import {claim} from '../packages/database/src/jobs.js';
import {createPhotoImport,selectionStep} from '../packages/database/src/photo-imports.js';
import type {PhotoClient} from '../packages/connectors/src/photos.js';
const url=process.env.TEST_DATABASE_URL;
test('Photos session imports only selected media and expires recoverably',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1,'google-photos',$2,'Photos','active')",[account,account]);
  let selected=false,lists=0;
  const client:PhotoClient={create:async()=>({id:'session',pickerUri:'https://photos.google.com/picker/session',expireTime:new Date(Date.now()+3600000).toISOString(),pollingConfig:{pollInterval:'1s'}}),get:async()=>({id:'session',pickerUri:'https://photos.google.com/picker/session',expireTime:new Date(Date.now()+3600000).toISOString(),mediaItemsSet:selected}),list:async()=>{lists++;return {mediaItems:[{id:'selected',type:'PHOTO',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/file',mimeType:'image/png',filename:'selected.png'}}]};},download:async()=>{throw new Error('Not selected phase');}};
  const session=await createPhotoImport(db,account,client);assert.ok(session.picker_uri);
  await db.query('UPDATE sync_jobs SET scheduled_at=now() WHERE account_id=$1',[account]);
  const poll=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(poll);assert.equal(await selectionStep(db,poll,client),true);assert.equal(lists,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM records WHERE account_id=$1',[account])).rows[0].n,0);
  selected=true;await db.query('UPDATE sync_jobs SET scheduled_at=now() WHERE account_id=$1',[account]);
  const job=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(job);assert.equal(await selectionStep(db,job,client),false);assert.equal(await selectionStep(db,job,client),true);
  assert.equal(lists,1);assert.equal((await db.query('SELECT external_id FROM records WHERE account_id=$1',[account])).rows[0].external_id,'selected');
  const other=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1,'google-photos',$2,'Photos expiry','active')",[other,other]);
  const expired=await createPhotoImport(db,other,client);await db.query("UPDATE photo_import_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
  await db.query("UPDATE sync_jobs SET scheduled_at=now() WHERE payload->>'sessionId'=$1",[expired.id]);
  const last=await claim(db,120,{accountId:other,stages:['photo']});assert.ok(last);await selectionStep(db,last,client);
  assert.equal((await db.query('SELECT status,error_code FROM photo_import_sessions WHERE id=$1',[expired.id])).rows[0].status,'expired');assert.equal(lists,1);
  const {retryJob}=await import('../packages/database/src/jobs.js');assert.equal(await retryJob(db,last.id),false);
  const replacement=await createPhotoImport(db,other,client);assert.notEqual(replacement.id,expired.id);assert.equal((await db.query('SELECT status FROM photo_import_sessions WHERE id=$1',[replacement.id])).rows[0].status,'selecting');
 }finally{await db.end();}
});

test('photo downloads deduplicate bytes and renew expired URLs within the selected session',{skip:!url},async()=>{
 const {downloadPhoto}=await import('../packages/database/src/photo-media.js');
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1,'google-photos',$2,'Media','active')",[account,account]);
  const item={id:'receipt',createTime:'2026-10-25T12:00:00Z',type:'PHOTO',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/old',mimeType:'image/png',filename:'receipt.png'}};
  let downloads=0;
  const client:PhotoClient={create:async()=>({id:randomUUID(),pickerUri:'https://photos.google.com/picker/s',expireTime:new Date(Date.now()+3600000).toISOString()}),get:async()=>({id:'s',pickerUri:'https://photos.google.com/picker/s',expireTime:new Date(Date.now()+3600000).toISOString(),mediaItemsSet:true}),list:async()=>({mediaItems:[{...item,mediaFile:{...item.mediaFile,baseUrl:'https://lh3.googleusercontent.com/new'}}]}),download:async()=>{if(downloads++===0){const {ProviderError}=await import('../packages/connectors/src/http.js');throw new ProviderError('photo_download_expired',403);}return Buffer.from('receipt-image-fixture');}};
  async function run(){
   const session=await createPhotoImport(db,account,client);await db.query("UPDATE sync_jobs SET scheduled_at=now() WHERE payload->>'sessionId'=$1",[session.id]);
   const parent=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(parent);await selectionStep(db,parent,client);await selectionStep(db,parent,client);
   const child=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(child);await downloadPhoto(db,child,client,1000);return session;
  }
  const first=await run();const firstRevision=(await db.query('SELECT revision_id FROM photo_import_items WHERE session_id=$1',[first.id])).rows[0].revision_id;
  // Analysis is a separate next task; remove its queued work from this download fixture.
  await db.query("UPDATE sync_jobs SET status='failed',error_code='fixture_analysis_not_run' WHERE account_id=$1 AND payload->>'action'='analyze'",[account]);
  const second=await run();assert.equal((await db.query('SELECT count(*)::int AS n FROM media_assets a JOIN records r ON r.id=a.record_id WHERE r.account_id=$1',[account])).rows[0].n,1);
  assert.equal((await db.query('SELECT revision_id FROM photo_import_items WHERE session_id=$1',[second.id])).rows[0].revision_id,firstRevision);
 }finally{await db.end();}
});

test('photo analysis stores OCR and descriptions separately and exposes unavailable models',{skip:!url},async()=>{
 const {downloadPhoto}=await import('../packages/database/src/photo-media.js');
 const {analyzePhoto,recordPhotoFailure}=await import('../packages/database/src/photo-analysis.js');
 const {failJob}=await import('../packages/database/src/jobs.js');
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1,'google-photos',$2,'Analysis','active')",[account,account]);
  const client:PhotoClient={create:async()=>({id:'analysis',pickerUri:'https://photos.google.com/picker/a',expireTime:new Date(Date.now()+3600000).toISOString()}),get:async()=>({id:'analysis',pickerUri:'https://photos.google.com/picker/a',expireTime:new Date(Date.now()+3600000).toISOString(),mediaItemsSet:true}),list:async()=>({mediaItems:[{id:'receipt',type:'PHOTO',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/receipt',mimeType:'image/png'}}]}),download:async()=>Buffer.from('receipt-fixture')};
  const session=await createPhotoImport(db,account,client);await db.query("UPDATE sync_jobs SET scheduled_at=now() WHERE account_id=$1",[account]);
  const parent=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(parent);await selectionStep(db,parent,client);await selectionStep(db,parent,client);
  const download=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(download);await downloadPhoto(db,download,client,1000);
  const analysis=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(analysis);
  await assert.rejects(analyzePhoto(db,analysis,{describe:async()=>{throw new Error('must not run');}},null),/photo_model_unconfigured/);
  await analyzePhoto(db,analysis,{describe:async image=>{assert.equal(Buffer.from(image.base64,'base64').toString(),'receipt-fixture');return {description:'Restaurant dinner receipt',ocr:'Example Cafe Total 12.34'};}},'fixture-vision@1');
  const rows=(await db.query('SELECT d.kind,d.text,d.model_version FROM derived_content d JOIN record_revisions v ON v.id=d.revision_id JOIN records r ON r.id=v.record_id WHERE r.account_id=$1 ORDER BY d.kind',[account])).rows;
  assert.deepEqual(rows.map(r=>r.kind),['description','ocr']);assert.ok(rows.every(r=>r.model_version==='fixture-vision@1'));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM derived_content d JOIN record_revisions v ON v.id=d.revision_id JOIN records r ON r.id=v.record_id WHERE r.account_id=$1 AND to_tsvector('english',d.text) @@ plainto_tsquery('english','Cafe')",[account])).rows[0].n,1);
  assert.equal((await db.query('SELECT status FROM photo_import_sessions WHERE id=$1',[session.id])).rows[0].status,'done');
  const revision=(analysis.payload as {revisionId:string}).revisionId;
  assert.ok(!JSON.stringify((await db.query('SELECT raw_payload FROM record_revisions WHERE id=$1',[revision])).rows[0]).includes('Example Cafe'));
  // Exhausted model work is operational failure, not a fabricated successful analysis.
  const failedId=(await db.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload,max_attempts) VALUES($1,$2,'photo',$3,$4,1) RETURNING id`,[account,analysis.stream_key,'failure:'+account,{...(analysis.payload as object),action:'analyze'}])).rows[0].id;
  const failed=await claim(db,120,{accountId:account,stages:['photo']});assert.equal(failed?.id,failedId);await failJob(db,failed!,'photo_model_unconfigured');await recordPhotoFailure(db,failed!,'photo_model_unconfigured');
  assert.equal((await db.query('SELECT status,error_code FROM photo_import_sessions WHERE id=$1',[session.id])).rows[0].error_code,'photo_model_unconfigured');
  const {retryJob}=await import('../packages/database/src/jobs.js');
  // Analysis uses stored bytes and remains recoverable after Picker expiration.
  await db.query("UPDATE photo_import_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[session.id]);
  const retried=await Promise.all([retryJob(db,failed!.id),retryJob(db,failed!.id)]);assert.deepEqual(retried.sort(),[false,true]);
  assert.equal((await db.query('SELECT status FROM photo_import_sessions WHERE id=$1',[session.id])).rows[0].status,'importing');
  const again=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(again);await analyzePhoto(db,again,{describe:async()=>{throw new Error('Existing derived artifacts should be reused');}},'fixture-vision@1');
  assert.equal((await db.query('SELECT status,error_code FROM photo_import_sessions WHERE id=$1',[session.id])).rows[0].status,'done');
  const {photoStatus}=await import('../packages/database/src/photo-status.js');const beforeIndex=(await photoStatus(db,null,session.id))[0];assert.equal(beforeIndex.counts.downloaded,1);assert.equal(beforeIndex.counts.analyzed,1);assert.equal(beforeIndex.counts.keyword_indexed,0);assert.equal(beforeIndex.counts.embedded,0);
  const {indexJob}=await import('../packages/database/src/indexing.js');
  const keyword=await claim(db,120,{accountId:account,stages:['embed']});assert.ok(keyword);await assert.rejects(indexJob(db,keyword,{embed:async()=>{throw new Error('unconfigured');}},null),/embedding_model_unconfigured/);await failJob(db,keyword,'embedding_model_unconfigured');
  const afterIndex=(await photoStatus(db,null,session.id))[0];assert.equal(afterIndex.counts.keyword_indexed,1);assert.equal(afterIndex.counts.embedded,0);assert.equal(afterIndex.embedding_model_configured,false);
  const {resumeConfiguredPhotoAnalysis}=await import('../packages/database/src/model-recovery.js');
  const interrupted=(await db.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload,status,error_code) VALUES($1,$2,'photo',$3,$4,'failed','photo_model_unconfigured') RETURNING id`,[account,analysis.stream_key,'configure-later:'+account,analysis.payload])).rows[0].id;
  await recordPhotoFailure(db,{...analysis,id:interrupted},'photo_model_unconfigured');
  assert.equal(await resumeConfiguredPhotoAnalysis(db,account),1);assert.equal(await resumeConfiguredPhotoAnalysis(db,account),0);
  const recovered=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(recovered);await analyzePhoto(db,recovered,{describe:async()=>{throw new Error('Reuse stored analysis');}},'fixture-vision@1');


 }finally{await db.end();}
});
test('selected videos retain metadata without downloading bytes or requiring an unexpired session',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});const account=randomUUID();
 try{
  await migrate(db);await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1::uuid,'google-photos',$1::text,'Video fixture','active')",[account]);
  const client:PhotoClient={create:async()=>({id:randomUUID(),pickerUri:'https://photos.google.com/picker/video',expireTime:new Date(Date.now()+3600000).toISOString()}),get:async()=>({id:'video',pickerUri:'https://photos.google.com/picker/video',expireTime:new Date(Date.now()+3600000).toISOString(),mediaItemsSet:true}),list:async()=>({mediaItems:[{id:'video',type:'VIDEO',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/video',mimeType:'video/mp4'}}]}),download:async()=>{throw new Error('Metadata-only video must never download bytes');}};
  const session=await createPhotoImport(db,account,client);await db.query("UPDATE sync_jobs SET scheduled_at=now() WHERE account_id=$1",[account]);
  const selection=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(selection);await selectionStep(db,selection,client);await selectionStep(db,selection,client);
  await db.query("UPDATE photo_import_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[session.id]);
  const download=await claim(db,120,{accountId:account,stages:['photo']});assert.ok(download);
  const {downloadPhoto}=await import('../packages/database/src/photo-media.js');await downloadPhoto(db,download,client,1);
  assert.equal((await db.query('SELECT status FROM photo_import_sessions WHERE id=$1',[session.id])).rows[0].status,'done');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM media_assets a JOIN records r ON r.id=a.record_id WHERE r.account_id=$1',[account])).rows[0].n,0);
  const {photoStatus}=await import('../packages/database/src/photo-status.js');assert.equal((await photoStatus(db,null,session.id))[0].counts.metadata_only,1);
 }finally{await db.end();}
});
