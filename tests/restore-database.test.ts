import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {migrate} from '../packages/database/src/migrate.js';
import {transaction,upsertRecord,provenance} from '../packages/database/src/records.js';
import {storeCredential,readCredential} from '../packages/database/src/credentials.js';
import {issueAgent,authenticateAgent} from '../packages/database/src/agents.js';
import {scheduleIndexes,indexJob} from '../packages/database/src/indexing.js';
import {claim,heartbeat} from '../packages/database/src/jobs.js';
import {getRevision} from '../packages/database/src/retrieval.js';
const url=process.env.TEST_DATABASE_URL;
function docker(args:string[],input?:Buffer):Promise<Buffer>{return new Promise((resolve,reject)=>{const child=spawn('docker',['compose','exec','-T','postgres',...args],{stdio:['pipe','pipe','pipe']});const output:Buffer[]=[];child.stdout.on('data',chunk=>output.push(chunk));child.stderr.resume();child.on('error',()=>reject(new Error('Backup container command could not start')));child.on('close',code=>code===0?resolve(Buffer.concat(output)):reject(new Error('Backup container command failed')));if(input)child.stdin.end(input);else child.stdin.end();});}
test('worker lease restart and PostgreSQL restore preserve media, encrypted access and exact chunk citations',{skip:!url||new URL(url).port!=='55439'},async()=>{
 const db=new pg.Pool({connectionString:url}),account=randomUUID(),restoredName='personal_context_restore_'+randomUUID().replaceAll('-',''),key=randomBytes(32).toString('base64');let restored:pg.Pool|undefined,created=false;
 try{
  await migrate(db);await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1::uuid,'google-photos',$1::text,'restore fixture')",[account]);
  const record=await transaction(db,c=>upsertRecord(c,{accountId:account,externalId:'backup-photo',kind:'photo',bodyText:'A receipt backup fixture',rawPayload:{}}));
  const bytes=Buffer.from('fixture-media-bytes'),hash=createHash('sha256').update(bytes).digest('hex');
  await db.query('INSERT INTO media_assets(record_id,sha256,mime_type,byte_size,bytes) VALUES($1,$2,$3,$4,$5)',[record.recordId,hash,'image/png',bytes.length,bytes]);
  await storeCredential(db,account,'fixture-provider-credential',key);const agent=await issueAgent(db,'restore client',[account]);
  await scheduleIndexes(db,{endpoint:'http://localhost',model:'restore-fixture',version:'1',dimensions:3,apiKey:undefined},account);
  const original=await claim(db,1,{accountId:account,stages:['embed']});assert.ok(original);
  await db.query("UPDATE sync_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[original.id]);
  const restarted=await claim(db,120,{accountId:account,stages:['embed']});assert.ok(restarted);assert.notEqual(restarted.lease_token,original.lease_token);assert.equal(await heartbeat(db,original),false);
  await indexJob(db,restarted,{embed:async texts=>texts.map(()=>[1,0,0])},{endpoint:'http://localhost',model:'restore-fixture',version:'1',dimensions:3,apiKey:undefined});
  const chunk=(await db.query('SELECT id FROM record_chunks WHERE revision_id=$1',[record.revisionId])).rows[0].id;
  const before=await getRevision(db,agent.id,record.recordId,record.revisionId!,chunk);assert.ok(before);
  const sourceName=new URL(url!).pathname.slice(1);assert.ok(/^personal_context_test_[a-f0-9]+$/.test(sourceName));
  const dump=await docker(['pg_dump','-U','personal_context','--format=custom','--dbname',sourceName]);
  await db.query(`CREATE DATABASE "${restoredName}"`);created=true;
  await docker(['pg_restore','-U','personal_context','--no-owner','--exit-on-error','--dbname',restoredName],dump);
  const restoredUrl=new URL(url!);restoredUrl.pathname='/'+restoredName;restored=new pg.Pool({connectionString:restoredUrl.toString()});
  assert.equal(await authenticateAgent(restored,agent.credential),agent.id);assert.equal(await readCredential(restored,account,key),'fixture-provider-credential');
  const after=await getRevision(restored,agent.id,record.recordId,record.revisionId!,chunk);assert.deepEqual(after?.provenance,before.provenance);assert.equal(after?.content,before.content);
  assert.deepEqual((await restored.query('SELECT bytes FROM media_assets WHERE record_id=$1',[record.recordId])).rows[0].bytes,bytes);
  console.log('Temporary database backup/restore verified; no owner database was restored or replaced.');
 }finally{await restored?.end();if(created)await db.query(`DROP DATABASE "${restoredName}" WITH (FORCE)`);await db.query("UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL WHERE account_id=$1 AND status IN ('queued','running')",[account]);await db.end();}
});
