import {readFile} from 'node:fs/promises';
import { personalRules } from '../packages/database/src/personal-rules.js';
import { calendarRecord } from '../packages/connectors/src/calendar.js';
import { gmailRecord } from '../packages/connectors/src/gmail.js';
import { issueAgent, authenticateAgent, revokeAgent, agentRead, auditRetrieval } from '../packages/database/src/agents.js';
import { createOAuthState, consumeOAuthState, storeCredential, readCredential } from '../packages/database/src/credentials.js';
import { randomBytes } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword, digest } from '@personal-context/security';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, claim, commitPage, failJob, retryJob } from '../packages/database/src/jobs.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { upsertRecord, transaction, provenance } from '../packages/database/src/records.js';
import { migrate } from '../packages/database/src/migrate.js';

const url = process.env.TEST_DATABASE_URL;
let pool: pg.Pool | undefined;
after(async () => { await pool?.end(); });
test('canonical migrations enforce identity, precision, ownership, and immutable revisions', { skip: !url }, async () => {
 pool = new pg.Pool({ connectionString: url });
 await migrate(pool);
 await migrate(pool);
 const c = await pool.connect();
 await c.query('BEGIN');
 const fails = async (sql: string, values: unknown[] = []) => {
  await c.query('SAVEPOINT invalid');
  await assert.rejects(c.query(sql, values));
  await c.query('ROLLBACK TO SAVEPOINT invalid');
 };
 try {
  const a = randomUUID(), b = randomUUID(), record = randomUUID(), revision = randomUUID();
  await c.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1::uuid,'gmail',$1::text,'A'),($2::uuid,'gmail',$2::text,'B')", [a,b]);
  await c.query("INSERT INTO records(id,account_id,external_id,kind) VALUES($1,$2,'msg','email')", [record,a]);
  await fails("INSERT INTO records(account_id,external_id,kind) VALUES($1,'msg','email')", [a]);
  await c.query("INSERT INTO record_revisions(id,record_id,revision_number,body_text,raw_payload,content_hash) VALUES($1,$2,1,'hello','{}','hash')", [revision,record]);
  await c.query('UPDATE records SET current_revision_id=$1 WHERE id=$2', [revision,record]);
  await fails("UPDATE record_revisions SET body_text='changed' WHERE id=$1", [revision]);
  const person = randomUUID();
  await c.query("INSERT INTO identities(id,account_id,external_id) VALUES($1,$2,'person')", [person,b]);
  await fails("INSERT INTO record_participants VALUES($1,$2,$3,'sender')", [record,a,person]);
  const finance = randomUUID();
  await c.query("INSERT INTO financial_accounts(id,source_account_id,external_id,type,balance) VALUES($1,$2,'bank','credit','12345678901234567890.12')", [finance,a]);
  assert.equal((await c.query('SELECT balance FROM financial_accounts WHERE id=$1',[finance])).rows[0].balance, '12345678901234567890.12');
  await c.query("INSERT INTO calendar_event_details(record_id,all_day,start_date,end_date,status) VALUES($1,true,'2026-10-25','2026-10-26','confirmed')",[record]);
  assert.equal((await c.query('SELECT start_date::text, starts_at FROM calendar_event_details WHERE record_id=$1',[record])).rows[0].start_date,'2026-10-25');
  await fails('UPDATE calendar_event_details SET starts_at=now() WHERE record_id=$1',[record]);
  const task = randomUUID(), chunk = randomUUID(), model = randomUUID();
  await fails("INSERT INTO tasks(account_id,title,description,status) VALUES($1,'request','details','done')",[a]);
  await c.query("INSERT INTO tasks(id,account_id,title,description,status) VALUES($1,$2,'request','details','open')",[task,b]);
  await fails("INSERT INTO task_records VALUES($1,$2,$3,$4,'request')",[task,b,record,revision]);
  await c.query("INSERT INTO record_chunks(id,revision_id,chunk_index,content,start_offset,end_offset) VALUES($1,$2,0,'hello',0,5)",[chunk,revision]);
  assert.equal((await c.query("SELECT count(*)::integer AS count FROM record_chunks WHERE id=$1 AND search_vector @@ plainto_tsquery('english','hello')",[chunk])).rows[0].count,1);
  await c.query("INSERT INTO embedding_models(id,provider,model_name,dimensions,version) VALUES($1,'test','test',3,'1')",[model]);
  await fails("INSERT INTO chunk_embeddings(chunk_id,embedding_model_id,dimensions,embedding) VALUES($1,$2,3,'[1,2]')",[chunk,model]);
  await c.query("INSERT INTO chunk_embeddings(chunk_id,embedding_model_id,dimensions,embedding) VALUES($1,$2,3,'[1,2,3]')",[chunk,model]);
  await fails("INSERT INTO media_assets(record_id,sha256,mime_type,byte_size,bytes) VALUES($1,'hash','image/png',2,decode('00','hex'))",[record]);
 } finally { await c.query('ROLLBACK'); c.release(); }
});

test('record ingestion is idempotent, revisioned and transactional', { skip: !url }, async () => {
 const db = new pg.Pool({ connectionString: url });
 const accountId = randomUUID();
 try {
  await migrate(db);
  await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1,'gmail',$2,'records-test')",[accountId,accountId]);
  const source = { accountId, externalId: 'email', kind: 'email', bodyText: 'first', sourceUrl: 'https://example.test/original', rawPayload: { b:2, a:1 } };
  const a = await transaction(db, c => upsertRecord(c,source));
  const b = await transaction(db, c => upsertRecord(c,{...source,rawPayload:{a:1,b:2}}));
  assert.equal(a.recordId,b.recordId); assert.equal(a.revisionId,b.revisionId); assert.equal(b.changed,false);
  const edit = await transaction(db,c=>upsertRecord(c,{...source,bodyText:'second',sourceUrl:'https://example.test/edited'}));
  assert.notEqual(edit.revisionId,a.revisionId);
  assert.equal((await db.query('SELECT body_text FROM record_revisions WHERE id=$1',[a.revisionId])).rows[0].body_text,'first');
  await assert.rejects(transaction(db,async c=>{await upsertRecord(c,{...source,externalId:'rolled-back'});throw new Error('crash');}));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM records WHERE account_id=$1 AND external_id='rolled-back'",[accountId])).rows[0].n,0);
  await transaction(db,c=>upsertRecord(c,{...source,deleted:true}));
  assert.ok((await db.query('SELECT deleted_at FROM records WHERE id=$1',[a.recordId])).rows[0].deleted_at);
  const row = (await db.query('SELECT r.id,v.id AS revision_id,v.source_url,v.source_created_at,v.source_updated_at,v.captured_at FROM records r JOIN record_revisions v ON v.record_id=r.id WHERE v.id=$1',[a.revisionId])).rows[0];
  const citation = provenance(row); assert.equal(citation.source_url,'https://example.test/original');assert.ok(citation.record_uri.includes(a.revisionId!));assert.ok(citation.ingested_at);
 } finally { await db.end(); }
});

test('job leases fence stale workers and commit records with checkpoints', { skip: !url }, async () => {
 const db = new pg.Pool({connectionString:url});
 const account = randomUUID();
 try {
  await migrate(db);
  await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1,'gmail',$2,'queue-test','active')",[account,account]);
  await db.query("INSERT INTO sync_state(account_id,stream_key) VALUES($1,'inbox')",[account]);
  await schedule(db); await schedule(db);
  const jobs = await Promise.all([claim(db),claim(db)]);
  const active = jobs.filter(j=>j?.account_id===account);
  assert.equal(active.length,1);
  const old = active[0]!;
  await db.query("UPDATE sync_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);
  const resumed = await claim(db);assert.ok(resumed);assert.notEqual(resumed.lease_token,old.lease_token);
  await assert.rejects(commitPage(db,old,{records:[],cursor:'bad',complete:true}),/lease/);
  await commitPage(db,resumed,{records:[{accountId:account,externalId:'queued-email',kind:'email',bodyText:'hello',rawPayload:{}}],cursor:'page-1',watermark:'2026-10-25T12:00:00Z',complete:true});
  const state=(await db.query('SELECT cursor,last_success_at,source_watermark_at FROM sync_state WHERE account_id=$1',[account])).rows[0];
  assert.equal(state.cursor,'page-1');assert.ok(state.last_success_at);assert.equal(state.source_watermark_at.toISOString(),'2026-10-25T12:00:00.000Z');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE account_id=$1 AND stage IN ('classify','embed')",[account])).rows[0].n,2);
  const downstream=await claim(db);assert.ok(downstream);
  await failJob(db,downstream,'rate_limited',120);
  const retry=(await db.query('SELECT scheduled_at,status FROM sync_jobs WHERE id=$1',[downstream.id])).rows[0];
  assert.equal(retry.status,'queued');assert.ok(retry.scheduled_at.getTime()>Date.now()+110000);
  await db.query("UPDATE sync_jobs SET status='failed' WHERE id=$1",[downstream.id]);
  // Other queued work in the same stream prevents an operator duplicate.
  assert.equal(await retryJob(db,downstream.id),false);
 } finally {
  await db.query("UPDATE source_accounts SET status='disabled' WHERE id=$1",[account]);
  await db.query("UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL WHERE account_id=$1 AND status IN ('queued','running')",[account]);
  await db.end();
 }
});

test('owner sessions reject forged requests and invalid OAuth state', {skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try {
  await migrate(db);
  await db.query('INSERT INTO owner_account(id,password_hash) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash',[await hashPassword('test-owner-password')]);
  const app=createApp(db,'http://127.0.0.1:5173');
  assert.equal((await app.request('/api/session')).status,401);
  assert.equal((await app.request('/auth/setup')).headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await (await app.request('/auth/setup')).json(),{configured:true});
  for(const path of ['/api/connections','/api/photos/imports'])assert.equal((await app.request(path)).status,401);
  const login=await app.request('/auth/login',{method:'POST',headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json'},body:JSON.stringify({password:'test-owner-password'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];const csrf=(await login.json()).csrf_token;
  assert.ok(login.headers.get('set-cookie')!.includes('HttpOnly'));
  assert.equal((await app.request('/api/session',{headers:{Cookie:cookie}})).status,200);
  const sessionDigest=digest(cookie.split('=')[1]);
  const state=await createOAuthState(db,sessionDigest,'gmail');
  await assert.rejects(consumeOAuthState(db,state,sessionDigest,'slack'),/Invalid/);
  await assert.rejects(consumeOAuthState(db,'forged',sessionDigest,'gmail'),/Invalid/);
  await consumeOAuthState(db,state,sessionDigest,'gmail');
  await assert.rejects(consumeOAuthState(db,state,sessionDigest,'gmail'),/Invalid/);
  const a=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1,'gmail',$2,'credential-test')",[a,a]);
  const key=randomBytes(32).toString('base64');await storeCredential(db,a,'private-provider-token',key);
  assert.equal(await readCredential(db,a,key),'private-provider-token');
  const connections=await app.request('/api/connections',{headers:{Cookie:cookie}});
  assert.equal(connections.status,200);assert.equal(connections.headers.get('Cache-Control'),'no-store');
  const listing=await connections.json();
  assert.ok(listing.accounts.some((x:{id:string})=>x.id===a));
  assert.deepEqual(listing.configured,{google:false,slack:false});
  assert.deepEqual(listing.setup_required.slack,['SLACK_CLIENT_ID','SLACK_CLIENT_SECRET','SLACK_APP_ID','CREDENTIAL_ENCRYPTION_KEY','SLACK_REDIRECT_URI']);
  assert.ok(!JSON.stringify(listing).includes('private-provider-token'));
  assert.ok(listing.accounts.every((x:object)=>Object.keys(x).every(k=>['id','provider','display_name','status','provider_environment'].includes(k))));
  const imports=await app.request('/api/photos/imports',{headers:{Cookie:cookie}});assert.equal(imports.status,200);assert.ok(Array.isArray((await imports.json()).imports));
  assert.ok(!(await db.query('SELECT ciphertext FROM encrypted_credentials ORDER BY created_at DESC LIMIT 1')).rows[0].ciphertext.includes('private-provider-token'));
  assert.equal((await app.request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:'http://evil.test','X-CSRF-Token':csrf}})).status,403);
  assert.equal((await app.request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:'http://127.0.0.1:5173'}})).status,403);
  for(const path of ['/api/operations/overview','/api/operations/agents','/api/operations/conversations'])assert.equal((await app.request(path)).status,401);
  const overviewResponse=await app.request('/api/operations/overview',{headers:{Cookie:cookie}});assert.equal(overviewResponse.status,200);
  const overview=await overviewResponse.json();assert.ok(Number(overview.storage.database_bytes)>0);assert.ok(Array.isArray(overview.stages));assert.ok(Array.isArray(overview.slack));
  assert.ok(!JSON.stringify(overview).includes('private-provider-token'));
  const conversation=(await db.query("INSERT INTO conversations(account_id,external_id,kind) VALUES($1,'settings-conversation','group') RETURNING id",[a])).rows[0].id;
  const settingPath='/api/operations/conversations/'+conversation+'/personal';
  assert.equal((await app.request(settingPath,{method:'PUT',headers:{Cookie:cookie,Origin:'http://evil.test'},body:JSON.stringify({personal:true})})).status,403);
  const authorized={Cookie:cookie,Origin:'http://127.0.0.1:5173','X-CSRF-Token':csrf,'Content-Type':'application/json'};
  assert.equal((await app.request(settingPath,{method:'PUT',headers:authorized,body:JSON.stringify({personal:'yes'})})).status,400);
  assert.equal((await app.request(settingPath,{method:'PUT',headers:authorized,body:JSON.stringify({personal:true})})).status,200);
  assert.equal((await app.request(settingPath,{method:'PUT',headers:authorized,body:JSON.stringify({personal:true})})).status,200);
  assert.equal((await db.query('SELECT personal_override FROM conversations WHERE id=$1',[conversation])).rows[0].personal_override,true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE dedupe_key=$1 AND status='queued'",['conversation-personal:'+conversation+':true'])).rows[0].n,1);
  const listed=await (await app.request('/api/operations/conversations',{headers:{Cookie:cookie}})).json();assert.ok(listed.conversations.some((x:{id:string})=>x.id===conversation));
  const agentResponse=await app.request('/api/agents',{method:'POST',headers:authorized,body:JSON.stringify({name:'dashboard-agent',accounts:[a]})});assert.equal(agentResponse.status,201);
  const issued=await agentResponse.json();const agentList=await (await app.request('/api/operations/agents',{headers:{Cookie:cookie}})).json();assert.ok(!JSON.stringify(agentList).includes(issued.credential));
  assert.ok(agentList.agents.some((x:{id:string;accounts:string[]})=>x.id===issued.id&&x.accounts.includes(a)));
  assert.equal((await app.request('/api/operations/overview',{headers:{Authorization:'Bearer '+issued.credential}})).status,401);
  assert.equal((await app.request('/api/agents/'+issued.id,{method:'DELETE',headers:authorized})).status,200);assert.equal(await authenticateAgent(db,issued.credential),null);
  const secret=cookie.split('=')[1];assert.equal((await db.query('SELECT token_digest FROM owner_sessions WHERE token_digest=$1',[digest(secret)])).rowCount,1);
  assert.equal((await app.request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:'http://127.0.0.1:5173','X-CSRF-Token':csrf}})).status,200);
  assert.equal((await app.request('/api/session',{headers:{Cookie:cookie}})).status,401);
 } finally { await db.end(); }
});

test('agent source grants are enforced by read-only database role', {skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try {
  await migrate(db);const a=randomUUID(),b=randomUUID();
  await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1,'gmail',$3,'grant-a'),($2,'gmail',$4,'grant-b')",[a,b,a,b]);
  const record=await transaction(db,c=>upsertRecord(c,{accountId:b,externalId:'hidden',kind:'email',bodyText:'private',rawPayload:{}}));
  const agent=await issueAgent(db,'test-agent',[a]);
  assert.equal(await authenticateAgent(db,agent.credential),agent.id);
  const visible=await agentRead(db,agent.id,c=>c.query('SELECT id FROM source_accounts'));
  assert.deepEqual(visible.rows.map(x=>x.id),[a]);
  assert.equal((await agentRead(db,agent.id,c=>c.query('SELECT id FROM records WHERE id=$1',[record.recordId]))).rowCount,0);
  assert.equal((await agentRead(db,agent.id,c=>c.query('SELECT id FROM record_revisions WHERE id=$1',[record.revisionId]))).rowCount,0);
  await assert.rejects(agentRead(db,agent.id,c=>c.query("UPDATE source_accounts SET display_name='forged'")),/permission denied|read-only/);
  await assert.rejects(agentRead(db,agent.id,c=>c.query('SELECT ciphertext FROM encrypted_credentials')),/permission denied/);
  await assert.rejects(agentRead(db,agent.id,c=>c.query('SELECT payload FROM sync_jobs')),/permission denied/);
  await auditRetrieval(db,agent.id,'get_record','denied',[]);
  const app=createApp(db,'http://127.0.0.1:5173');
  assert.equal((await app.request('/api/agents',{method:'POST',headers:{Authorization:'Bearer '+agent.credential,Origin:'http://127.0.0.1:5173'}})).status,401);
  await revokeAgent(db,agent.id);assert.equal(await authenticateAgent(db,agent.credential),null);
  assert.equal((await agentRead(db,agent.id,c=>c.query('SELECT id FROM source_accounts'))).rowCount,0);
 } finally {await db.end();}
});

test('OAuth callbacks validate state before exchange and hide provider errors', {skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try {
  await migrate(db);const raw='oauth-session',csrf='csrf';
  await db.query("INSERT INTO owner_sessions(token_digest,csrf_digest,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(raw),digest(csrf)]);
  let calls=0;const request:typeof fetch=async()=>{calls++;return new Response('private-provider-token',{status:400});};
  const app=createApp(db,'http://127.0.0.1:5173',{googleClientId:'client',googleClientSecret:'secret',encryptionKey:randomBytes(32).toString('base64')},request);
  const headers={Cookie:'owner_session='+raw,Origin:'http://127.0.0.1:5173','X-CSRF-Token':csrf};
  const start=await app.request('/api/connections/gmail/start',{method:'POST',headers});assert.equal(start.status,200);
  const redirect=new URL((await start.json()).authorization_url);assert.equal(redirect.hostname,'accounts.google.com');
  const forged=await app.request('/api/connections/gmail/callback?state=forged&code=x',{headers});assert.equal(forged.status,400);assert.equal(calls,0);
  const callback=await app.request('/api/connections/gmail/callback?state='+redirect.searchParams.get('state')+'&code=x',{headers});assert.equal(callback.status,502);assert.ok(!(await callback.text()).includes('private-provider-token'));assert.equal(calls,1);
  const replay=await app.request('/api/connections/gmail/callback?state='+redirect.searchParams.get('state')+'&code=x',{headers});assert.equal(replay.status,400);assert.equal(calls,1);
 } finally {await db.end();}
});

test('Gmail replay persists participants and reply details once', {skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try {
  await migrate(db);const account=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1,'gmail',$2,'gmail-test')",[account,account]);
  const message={id:'m1',threadId:'t1',payload:{headers:[{name:'From',value:'me@example.test'},{name:'To',value:'other@example.test'},{name:'In-Reply-To',value:'<original>'}],body:{data:Buffer.from('hello').toString('base64url')}}};
  const source=gmailRecord(account,message,'me@example.test');const first=await transaction(db,c=>upsertRecord(c,source));const second=await transaction(db,c=>upsertRecord(c,source));
  assert.equal(first.revisionId,second.revisionId);
  assert.equal((await db.query('SELECT in_reply_to FROM email_details WHERE record_id=$1',[first.recordId])).rows[0].in_reply_to,'<original>');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM record_participants WHERE record_id=$1',[first.recordId])).rows[0].n,2);
  assert.equal((await personalRules(db,first.recordId)).personal,true);
  const reply=gmailRecord(account,{id:'reply',threadId:'t1',payload:{headers:[{name:'From',value:'other@example.test'},{name:'To',value:'me@example.test'},{name:'In-Reply-To',value:'<mine>'}],body:{data:Buffer.from('Which refund option?').toString('base64url')}}},'me@example.test');
  await db.query('UPDATE email_details SET message_id_header=$2 WHERE record_id=$1',[first.recordId,'<mine>']);
  const r=await transaction(db,c=>upsertRecord(c,reply));const evidence=await personalRules(db,r.recordId);assert.ok(evidence.reasons.some(x=>x.kind==='reply-to-owner'&&x.recordId===first.recordId));
  const group=(await db.query("INSERT INTO conversations(account_id,external_id,kind) VALUES($1,'group-rules','group') RETURNING id",[account])).rows[0].id;
  const now=new Date('2026-10-25T15:00:00Z');let groupRecord='';
  for(let n=0;n<20;n++){
   const stored=await transaction(db,c=>upsertRecord(c,{accountId:account,externalId:'group-'+n,kind:'slack-message',conversationId:group,bodyText:'fixture',sourceCreatedAt:now.toISOString(),participants:[{externalId:n<2?'me':'other',isSelf:n<2,role:'author'}],rawPayload:{}}));groupRecord=stored.recordId;
  }
  const groupEvidence=await personalRules(db,groupRecord,now);assert.equal(groupEvidence.personal,true);assert.equal(groupEvidence.participation?.self,2);assert.equal(groupEvidence.participation?.coverageComplete,false);
  assert.equal((await personalRules(db,groupRecord,new Date(now.getTime()+7*86400000))).personal,false);
  await db.query('UPDATE conversations SET personal_override=true WHERE id=$1',[group]);assert.equal((await personalRules(db,groupRecord,new Date(now.getTime()+7*86400000))).personal,true);
 } finally {await db.end();}
});

test('calendar records persist recurrence, all-day boundaries and series cancellations',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1,'calendar',$2,'calendar-test')",[account,account]);
  const master=calendarRecord(account,'cal',{id:'series',summary:'weekly',start:{dateTime:'2026-10-25T09:00:00-04:00',timeZone:'America/New_York'},end:{dateTime:'2026-10-25T10:00:00-04:00'},recurrence:['RRULE:FREQ=WEEKLY']});
  const allDay=calendarRecord(account,'cal',{id:'day',start:{date:'2026-10-25'},end:{date:'2026-10-26'}});
  const exception=calendarRecord(account,'cal',{id:'instance',recurringEventId:'series',originalStartTime:{dateTime:'2026-11-01T09:00:00-05:00'},start:{dateTime:'2026-11-01T10:00:00-05:00'},end:{dateTime:'2026-11-01T11:00:00-05:00'}});
  const stored=await transaction(db,async c=>{await upsertRecord(c,master);const d=await upsertRecord(c,allDay);const e=await upsertRecord(c,exception);return {d,e};});
  const date=(await db.query('SELECT start_date::text,end_date::text,starts_at FROM calendar_event_details WHERE record_id=$1',[stored.d.recordId])).rows[0];assert.deepEqual(date,{start_date:'2026-10-25',end_date:'2026-10-26',starts_at:null});
  const detail=(await db.query('SELECT recurrence_id,original_start,starts_at FROM calendar_event_details WHERE record_id=$1',[stored.e.recordId])).rows[0];assert.equal(detail.recurrence_id,'cal:series');assert.equal(detail.starts_at.toISOString(),'2026-11-01T15:00:00.000Z');
  await transaction(db,c=>upsertRecord(c,calendarRecord(account,'cal',{id:'series',status:'cancelled'})));
  assert.ok((await db.query('SELECT deleted_at FROM records WHERE id=$1',[stored.e.recordId])).rows[0].deleted_at);
 }finally{await db.end();}
});

test('operations statistics cover active current data independently of bounded history', {skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try {
  await migrate(db);
  await db.query('INSERT INTO owner_account(id,password_hash) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash',[await hashPassword('history-owner-password')]);
  const app=createApp(db,'http://127.0.0.1:5173');
  const login=await app.request('/auth/login',{method:'POST',headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json'},body:JSON.stringify({password:'history-owner-password'})});
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const get=async(path:string)=>{const response=await app.request(path,{headers:{Cookie:cookie}});assert.equal(response.status,200,await response.clone().text());return response.json();};
  const a=randomUUID(),empty=randomUUID(),photos=randomUUID();
  for(const [id,provider] of [[a,'gmail'],[empty,'calendar'],[photos,'google-photos']])await db.query('INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1::uuid,$2,$1::text,$2,\'active\')',[id,provider]);
  await db.query("INSERT INTO sync_state(account_id,stream_key,last_attempt_at,last_success_at) VALUES($1,'history',now(),now()-interval '1 day')",[a]);
  const baseline=await get('/api/operations/overview');
  for(let i=0;i<4;i++){
   const id=randomUUID(),revision=randomUUID();
   await db.query("INSERT INTO records(id,account_id,external_id,kind) VALUES($1::uuid,$2,$1::text,'email')",[id,a]);
   await db.query("INSERT INTO record_revisions(id,record_id,revision_number,body_text,raw_payload,content_hash) VALUES($1::uuid,$2,1,'PRIVATE RAW CONTENT','{}',$1::text)",[revision,id]);
   await db.query('UPDATE records SET current_revision_id=$1 WHERE id=$2',[revision,id]);
   if(i===3){await db.query('UPDATE records SET deleted_at=now() WHERE id=$1',[id]);continue;}
   const run=(await db.query("INSERT INTO classification_runs(record_id,revision_id,context_version,status,classifier_version,rules_version) SELECT id,current_revision_id,context_version,'done','test','test' FROM records WHERE id=$1 RETURNING id",[id])).rows[0].id;
   for(const label of ['personal','blocking'])await db.query("INSERT INTO record_labels(record_id,label,classification_run_id,reason) VALUES($1,$2,$3,'private evidence')",[id,label,run]);
   if(i===1)await db.query('UPDATE records SET context_version=context_version+1 WHERE id=$1',[id]);
   if(i===2){await db.query("UPDATE classification_runs SET status='failed' WHERE id=$1",[run]);await db.query('DELETE FROM record_labels WHERE record_id=$1',[id]);await db.query("INSERT INTO record_labels(record_id,label,classification_run_id,reason) VALUES($1,'unorganized',$2,'failure')",[id,run]);}
  }
  const overview=await get('/api/operations/overview');
  assert.equal(overview.records.total,baseline.records.total+3);assert.equal(overview.records.pending_stale,baseline.records.pending_stale+1);
  assert.equal(overview.sources.find((s:{account_id:string})=>s.account_id===a).count,3);
  assert.equal(overview.sources.find((s:{account_id:string})=>s.account_id===empty).count,0);
  for(const label of ['personal','blocking','unorganized'])assert.equal(overview.classifications.find((l:{label:string})=>l.label===label).count,baseline.classifications.find((l:{label:string})=>l.label===label).count+1);
  assert.equal(overview.classifications.length,5);assert.ok(!('jobs'in overview));assert.ok(!JSON.stringify(overview).includes('PRIVATE RAW CONTENT'));
  assert.ok(overview.sources.some((s:{provider:string;last_import_at:unknown})=>s.provider==='google-photos'&&s.last_import_at===null));
  assert.ok(new Date(overview.streams.find((s:{account_id:string})=>s.account_id===a).last_attempt_at)>new Date(overview.streams.find((s:{account_id:string})=>s.account_id===a).last_success_at));
  const endpoint='/api/operations/jobs?source='+a;
  assert.equal((await get(endpoint)).items.length,0);
  for(let i=0;i<101;i++)await db.query("INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,status,error_code,created_at,payload) VALUES($1,'history','ingest',$2,'failed','provider_unavailable','2026-01-01 01:01:01.123456+00','{\"secret\":\"PRIVATE RAW CONTENT\"}')",[a,randomUUID()]);
  const first=await get(endpoint);assert.equal(first.items.length,50);assert.ok(first.next_cursor);assert.ok(!JSON.stringify(first).includes('PRIVATE RAW CONTENT'));
  const retryId=first.items[0].id,original=first.items[0].created_at;
  assert.equal((await app.request('/api/operations/jobs/'+retryId+'/retry',{method:'POST',headers:{Cookie:cookie}})).status,403);
  await db.query("UPDATE sync_jobs SET scheduled_at=now(),status='queued' WHERE id=$1",[retryId]);
  assert.equal((await db.query('SELECT created_at FROM sync_jobs WHERE id=$1',[retryId])).rows[0].created_at.toISOString(),original);
  await assert.rejects(db.query('UPDATE sync_jobs SET created_at=now() WHERE id=$1',[retryId]),/immutable/);
  await db.query("INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,status) VALUES($1,'history','ingest',$2,'failed')",[a,randomUUID()]);
  const second=await get(endpoint+'&cursor='+first.next_cursor);assert.equal(second.items.length,50);
  const third=await get(endpoint+'&cursor='+second.next_cursor);assert.equal(third.items.length,1);assert.equal(third.next_cursor,null);
  assert.equal(new Set([...first.items,...second.items,...third.items].map(x=>x.id)).size,101);
  for(const suffix of ['&cursor=bad','&status=unknown','&from=oops','&from=2026-02-30T00:00:00Z','&from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z','&status=failed&cursor='+first.next_cursor])assert.equal((await app.request(endpoint+suffix,{headers:{Cookie:cookie}})).status,400);
  assert.equal((await app.request('/api/operations/jobs?source=bad',{headers:{Cookie:cookie}})).status,400);
  const onlyFailed=await get('/api/operations/failures?source='+a);assert.equal(onlyFailed.items.length,50);assert.ok(onlyFailed.items.every((x:{status:string})=>x.status==='failed'));
  for(let i=0;i<51;i++)await db.query("INSERT INTO photo_import_sessions(account_id,provider_session_ref,status,expires_at,created_at,error_code) VALUES($1,$2,$3,now(),'2026-01-01 01:01:01.123456+00','selection_expired')",[photos,randomUUID(),i%2?'failed':'expired']);
  const ip='/api/photos/imports?source='+photos,imports=await get(ip);assert.equal(imports.imports.length,50);
  const last=await get(ip+'&cursor='+imports.next_cursor);assert.equal(last.imports.length,1);assert.equal(last.next_cursor,null);
  assert.equal(new Set([...imports.imports,...last.imports].map(x=>x.id)).size,51);assert.equal(Number(imports.imports[0].counts.selected),0);
  assert.equal((await get('/api/photos/sessions/'+imports.imports[0].id)).id,imports.imports[0].id);
  const mixed=await get('/api/operations/failures');const mixedNext=await get('/api/operations/failures?cursor='+mixed.next_cursor);
  assert.equal(new Set([...mixed.items,...mixedNext.items].map(x=>x.entry_type+x.id)).size,100);
  const expired=await get('/api/operations/failures?status=expired&source='+photos);assert.ok(expired.items.length>0);assert.ok(expired.items.every((x:{entry_type:string;status:string})=>x.entry_type==='import'&&x.status==='expired'));
  const issued=await issueAgent(db,'history-agent',[a]);
  for(const path of ['/api/operations/jobs','/api/operations/failures','/api/photos/imports']){
   assert.equal((await app.request(path)).status,401);assert.equal((await app.request(path,{headers:{Authorization:'Bearer '+issued.credential}})).status,401);
  }
  for(let i=0;i<51;i++)await db.query("INSERT INTO conversations(account_id,external_id,kind) VALUES($1,$2,'group')",[a,randomUUID()]);
  const cp=await get('/api/operations/conversations');assert.equal(cp.conversations.length,50);const cn=await get('/api/operations/conversations?after='+cp.next_cursor);assert.ok(cn.conversations.length>0);assert.ok(!cn.conversations.some((x:{id:string})=>cp.conversations.some((y:{id:string})=>x.id===y.id)));
  const plan=await db.query("EXPLAIN (FORMAT JSON) SELECT id FROM sync_jobs WHERE account_id=$1 AND status='failed' ORDER BY created_at DESC,id DESC LIMIT 51",[a]);
  assert.equal(plan.rows[0]['QUERY PLAN'][0].Plan['Node Type'],'Limit');
  const after=await get('/api/operations/overview');assert.equal(after.records.total,overview.records.total);
 }finally{await db.end();}
});

test('history migration backfills legacy dates, preserves new dates and supports bounded indexed retrieval',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url}),client=await db.connect(),schema='history_migration_'+randomUUID().replaceAll('-','');
 try{
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}", public`);
  await client.query(`CREATE TABLE sync_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL DEFAULT gen_random_uuid(),status text NOT NULL DEFAULT 'failed',scheduled_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z');
   CREATE TABLE photo_import_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL DEFAULT gen_random_uuid(),status text NOT NULL DEFAULT 'expired',expires_at timestamptz NOT NULL DEFAULT '2026-02-01T00:00:00Z');
   INSERT INTO sync_jobs DEFAULT VALUES; INSERT INTO photo_import_sessions DEFAULT VALUES`);
  await client.query(await readFile(new URL('../packages/database/migrations/017-operational-history.sql',import.meta.url),'utf8'));
  assert.equal((await client.query('SELECT created_at=scheduled_at AS matches FROM sync_jobs')).rows[0].matches,true);
  assert.equal((await client.query('SELECT created_at=expires_at AS matches FROM photo_import_sessions')).rows[0].matches,true);
  await client.query('COMMIT');await client.query('BEGIN');await client.query(`SET LOCAL search_path TO "${schema}", public`);
  // Keep the requested source selective; at 10% PostgreSQL can reasonably
  // prefer a sequential scan, making an index-plan assertion unstable.
  await client.query("INSERT INTO sync_jobs(account_id) SELECT CASE WHEN n%100=0 THEN '11111111-1111-4111-8111-111111111111'::uuid ELSE gen_random_uuid() END FROM generate_series(1,10000) AS g(n)");
  await client.query('INSERT INTO photo_import_sessions DEFAULT VALUES');
  assert.equal((await client.query('SELECT bool_and(created_at=now()) AS matches FROM sync_jobs WHERE created_at<>scheduled_at')).rows[0].matches,true);
  await client.query('ANALYZE sync_jobs');
  const plan=await client.query("EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM sync_jobs WHERE account_id='11111111-1111-4111-8111-111111111111' ORDER BY created_at DESC,id DESC LIMIT 51");
  assert.equal(plan.rows[0]['QUERY PLAN'][0].Plan['Node Type'],'Limit');
  assert.equal(plan.rows[0]['QUERY PLAN'][0].Plan['Actual Rows'],51);
  assert.ok(JSON.stringify(plan.rows).includes('jobs_history'),JSON.stringify(plan.rows));
 }finally{await client.query('ROLLBACK');await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);client.release();await db.end();}
});

test('overview latest ingestion status uses a stream index across large multi-stream history',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url}),client=await db.connect(),schema='stream_index_'+randomUUID().replaceAll('-','');
 try{
  await client.query('BEGIN');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}", public`);
  await client.query(`CREATE TABLE sync_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL,stream_key text NOT NULL,stage text NOT NULL,status text NOT NULL,error_code text,created_at timestamptz NOT NULL);
   INSERT INTO sync_jobs(account_id,stream_key,stage,status,created_at)
   SELECT '11111111-1111-4111-8111-111111111111'::uuid,'stream:'||(n%2000),'ingest','done',now()-make_interval(secs=>n) FROM generate_series(1,10000) AS g(n)`);
  await client.query(await readFile(new URL('../packages/database/migrations/018-stream-job-status.sql',import.meta.url),'utf8'));
  await client.query('ANALYZE sync_jobs');
  const plan=await client.query("EXPLAIN (ANALYZE, FORMAT JSON) SELECT status,error_code FROM sync_jobs WHERE account_id='11111111-1111-4111-8111-111111111111' AND stream_key='stream:1999' AND stage='ingest' ORDER BY created_at DESC,id DESC LIMIT 1");
  const root=plan.rows[0]['QUERY PLAN'][0].Plan;
  assert.equal(root['Actual Rows'],1);assert.equal(root.Plans[0]['Index Name'],'jobs_stream_latest_ingest');
  assert.equal(root.Plans[0]['Rows Removed by Filter']??0,0);
 }finally{await client.query('ROLLBACK');client.release();await db.end();}
});

test('Slack OAuth uses its HTTPS callback for authorize/exchange and returns to the owner dashboard',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});let accountId:string|undefined;
 try{
  await migrate(db);const session='slack-https-fixture',csrf='slack-https-csrf';
  await db.query("INSERT INTO owner_sessions(token_digest,csrf_digest,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(session),digest(csrf)]);
  const callback='https://127.0.0.1:5443/api/connections/slack/callback';let exchanges=0;
  const request:typeof fetch=async(_input,init)=>{exchanges++;const form=new URLSearchParams(String(init?.body));assert.equal(form.get('redirect_uri'),callback);return Response.json({ok:true,app_id:'A_fixture',team:{id:'T_fixture',name:'Fixture workspace'},authed_user:{id:'U_fixture',access_token:'fixture-slack-access',scope:'channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read'}});};
  const config={slackClientId:'fixture-client',slackClientSecret:'fixture-secret',slackAppId:'A_fixture',slackRedirectUri:callback,encryptionKey:randomBytes(32).toString('base64')};
  const app=createApp(db,'http://127.0.0.1:5173',config,request);const headers={Cookie:'owner_session='+session,Origin:'http://127.0.0.1:5173','X-CSRF-Token':csrf};
  const started=await app.request('/api/connections/slack/start',{method:'POST',headers});assert.equal(started.status,200);const authorize=new URL((await started.json()).authorization_url);assert.equal(authorize.searchParams.get('redirect_uri'),callback);assert.ok(authorize.searchParams.get('user_scope')?.includes('im:history'));
  const response=await app.request('/api/connections/slack/callback?code=fixture&state='+authorize.searchParams.get('state'),{headers:{Cookie:headers.Cookie,Accept:'text/html'}});assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'http://127.0.0.1:5173/?connection=success');assert.equal(exchanges,1);
  accountId=(await db.query("SELECT id FROM source_accounts WHERE provider='slack' AND external_account_id='T_fixture:U_fixture'")).rows[0].id;
  assert.equal((await db.query('SELECT status FROM source_accounts WHERE id=$1',[accountId])).rows[0].status,'active');
  assert.throws(()=>createApp(db,'http://127.0.0.1:5173',{...config,slackRedirectUri:'https://other.test/api/connections/slack/callback'}),/dashboard host/);
 }finally{if(accountId)await db.query("UPDATE source_accounts SET status='disabled' WHERE id=$1",[accountId]);await db.end();}
});
