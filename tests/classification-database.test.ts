import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../packages/database/src/migrate.js';
import {transaction,upsertRecord} from '../packages/database/src/records.js';
import {classifyJob} from '../packages/database/src/classification.js';
import {claim,retryJob,type Job} from '../packages/database/src/jobs.js';
const url=process.env.TEST_DATABASE_URL;
async function fixture(run:(db:pg.Pool,account:string)=>Promise<void>){const db=new pg.Pool({connectionString:url});const account=randomUUID();try{await migrate(db);await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name) VALUES($1::uuid,'gmail',$1::text,'classification fixture')",[account]);await db.query("INSERT INTO sync_state(account_id,stream_key,enabled) VALUES($1,'pipeline',false)",[account]);await run(db,account);}finally{await db.query("UPDATE sync_jobs SET status='failed',lease_token=NULL,lease_until=NULL WHERE account_id=$1 AND status IN ('queued','running')",[account]);await db.end();}}
async function enqueue(db:pg.Pool,account:string,recordId:string,revisionId:string,maxAttempts=2):Promise<Job>{await db.query("INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload,max_attempts) VALUES($1,'pipeline','classify',$2,$3,$4)",[account,randomUUID(),{recordId,revisionId},maxAttempts]);const job=await claim(db,120,{accountId:account,stages:['classify']});assert.ok(job);return job;}
test('classification persists overlapping evidence and separates pending from failures',{skip:!url},()=>fixture(async(db,account)=>{
 const own=await transaction(db,c=>upsertRecord(c,{accountId:account,externalId:'mine',kind:'email',bodyText:'I requested this',rawPayload:{},email:{messageIdHeader:'<mine>',inReplyTo:null,labels:[]},participants:[{externalId:'me',isSelf:true,role:'sender'}]}));
 const reply=await transaction(db,c=>upsertRecord(c,{accountId:account,externalId:'reply',kind:'email',bodyText:'Would you prefer a refund?',rawPayload:{},email:{messageIdHeader:'<reply>',inReplyTo:'<mine>',labels:[]}}));
 const job=await enqueue(db,account,reply.recordId,reply.revisionId!);
 await classifyJob(db,job,{classify:async()=>{
  assert.equal((await db.query('SELECT status FROM classification_runs WHERE job_id=$1',[job.id])).rows[0].status,'pending');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM record_labels WHERE record_id=$1',[reply.recordId])).rows[0].n,0);
  return {labels:['blocking'],reason:'Reply asks owner to choose a refund option',confidence:0.9};
 }},'fixture@1');
 const classified=(await db.query('SELECT label FROM record_labels WHERE record_id=$1 ORDER BY label',[reply.recordId])).rows.map(r=>r.label);assert.deepEqual(classified,['blocking','personal']);
 const run=(await db.query('SELECT * FROM classification_runs WHERE job_id=$1',[job.id])).rows[0];assert.equal(run.status,'done');assert.equal(run.classifier_version,'fixture@1');assert.ok(run.evidence.personal.reasons.some((r:{recordId:string})=>r.recordId===own.recordId));
 for(const [externalId,text,label]of [['newsletter','Weekly promotions','background'],['payment','Your payment is due soon','update']]as const){const record=await transaction(db,c=>upsertRecord(c,{accountId:account,externalId,kind:'email',bodyText:text,rawPayload:{}}));const j=await enqueue(db,account,record.recordId,record.revisionId!);await classifyJob(db,j,{classify:async()=>({labels:[label],reason:text,confidence:null})},'fixture@1');assert.deepEqual((await db.query('SELECT label FROM record_labels WHERE record_id=$1',[record.recordId])).rows.map(r=>r.label),[label]);}
}));
test('classification outages use bounded retries and unorganized recovers without losing history',{skip:!url},()=>fixture(async(db,account)=>{
 const record=await transaction(db,c=>upsertRecord(c,{accountId:account,externalId:'outage',kind:'email',bodyText:'payment notice',rawPayload:{}}));
 let job=await enqueue(db,account,record.recordId,record.revisionId!);
 const broken={classify:async()=>{throw new Error('private source text must not become error_code');}};
 await classifyJob(db,job,broken,'fixture@1');
 assert.equal((await db.query('SELECT status FROM sync_jobs WHERE id=$1',[job.id])).rows[0].status,'queued');assert.equal((await db.query('SELECT count(*)::int AS n FROM record_labels WHERE record_id=$1',[record.recordId])).rows[0].n,0);
 await db.query('UPDATE sync_jobs SET scheduled_at=now() WHERE id=$1',[job.id]);job=(await claim(db,120,{accountId:account,stages:['classify']}))!;
 await classifyJob(db,job,broken,'fixture@1');assert.equal((await db.query('SELECT label FROM record_labels WHERE record_id=$1',[record.recordId])).rows[0].label,'unorganized');
 assert.equal(await retryJob(db,job.id),true);job=(await claim(db,120,{accountId:account,stages:['classify']}))!;
 await classifyJob(db,job,{classify:async()=>({labels:['update'],reason:'Upcoming payment',confidence:0.8})},'fixture@1');
 assert.deepEqual((await db.query('SELECT label FROM record_labels WHERE record_id=$1',[record.recordId])).rows.map(r=>r.label),['update']);
 const runs=(await db.query('SELECT status,error_code FROM classification_runs WHERE record_id=$1',[record.recordId])).rows;assert.equal(runs.filter(r=>r.status==='failed').length,2);assert.equal(runs.filter(r=>r.status==='done').length,1);assert.ok(runs.every(r=>r.error_code===null||r.error_code==='classification_failed'));
}));
test('classification cannot publish results for a changed source snapshot',{skip:!url},()=>fixture(async(db,account)=>{
 const source={accountId:account,externalId:'edited',kind:'email',bodyText:'old request',rawPayload:{}};const record=await transaction(db,c=>upsertRecord(c,source));const job=await enqueue(db,account,record.recordId,record.revisionId!);
 await classifyJob(db,job,{classify:async()=>{await transaction(db,c=>upsertRecord(c,{...source,bodyText:'request withdrawn'}));return {labels:['blocking'],reason:'outdated',confidence:1};}},'fixture@1');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM record_labels WHERE record_id=$1',[record.recordId])).rows[0].n,0);assert.equal((await db.query('SELECT error_code FROM classification_runs WHERE job_id=$1',[job.id])).rows[0].error_code,'classification_superseded');
}));
test('reclassification invalidates conversation labels and schedules exact rolling expiry',{skip:!url},()=>fixture(async(db,account)=>{
 const {scheduleClassifications}=await import('../packages/database/src/classification-scheduling.js');
 const now=new Date('2026-10-25T15:00:00Z');
 const source={accountId:account,externalId:'group-message',kind:'slack-message',conversation:{externalId:'group',kind:'group',title:'Fixture group'},participants:[{externalId:'me',isSelf:true,role:'author'}],bodyText:'owner message',sourceCreatedAt:new Date(now.getTime()-7*86400000+1000).toISOString(),rawPayload:{}};
 const record=await transaction(db,c=>upsertRecord(c,source));
 const conversation=(await db.query('SELECT conversation_id FROM records WHERE id=$1',[record.recordId])).rows[0].conversation_id;
 await db.query('UPDATE conversations SET relevance_check_at=$2 WHERE id=$1',[conversation,now]);
 await scheduleClassifications(db,'fixture@1',now,account);
 let job=(await claim(db,120,{accountId:account,stages:['classify']}))!;assert.ok(job);
 // Use a fixed evaluation clock for source activity boundaries through the scheduler;
 // persisted classification runs use the actual current clock.
 await classifyJob(db,job,{classify:async()=>({labels:['background'],reason:'Context',confidence:null})},'fixture@1');
 const before=(await db.query('SELECT context_version FROM records WHERE id=$1',[record.recordId])).rows[0].context_version;
 const due=(await db.query('SELECT relevance_check_at FROM conversations WHERE id=$1',[conversation])).rows[0].relevance_check_at;assert.equal(due.toISOString(),new Date(now.getTime()+1000).toISOString());
 await scheduleClassifications(db,'fixture@1',new Date(now.getTime()+1000),account);
 assert.notEqual((await db.query('SELECT context_version FROM records WHERE id=$1',[record.recordId])).rows[0].context_version,before);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM record_labels WHERE record_id=$1',[record.recordId])).rows[0].n,0);
 const count=(await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE account_id=$1 AND stage='classify' AND status='queued'",[account])).rows[0].n;assert.equal(count,1);
 await scheduleClassifications(db,'fixture@1',new Date(now.getTime()+1000),account);assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE account_id=$1 AND stage='classify' AND status='queued'",[account])).rows[0].n,1);
 await db.query('UPDATE conversations SET personal_override=true WHERE id=$1',[conversation]);assert.equal((await db.query('SELECT count(*)::int AS n FROM record_labels WHERE record_id=$1',[record.recordId])).rows[0].n,0);
}));
test('tasks keep multiple requests, conservative follow-ups, exact quotes and later source resolution',{skip:!url},()=>fixture(async(db,account)=>{
 const {applyTasks}=await import('../packages/database/src/task-extraction.js');
 const source={accountId:account,externalId:'requests',kind:'email',conversation:{externalId:'requests-thread',kind:'email-thread',title:'Requests'},bodyText:'Please approve the refund. Please send the receipt.',sourceCreatedAt:'2026-10-20T12:00:00Z',rawPayload:{}};
 const original=await transaction(db,c=>upsertRecord(c,source));const job=await enqueue(db,account,original.recordId,original.revisionId!);
 const requests=[{title:'Approve refund',description:'Choose the refund course of action',quote:'Please approve the refund.',due_at:'2026-10-21T12:00:00Z',existing_task_id:null},{title:'Send receipt',description:'Send the requested receipt',quote:'Please send the receipt.',due_at:null,existing_task_id:null}];
 await classifyJob(db,job,{classify:async()=>({labels:['blocking'],reason:'Two explicit requests',confidence:0.9}),extractTasks:async()=>({requests,resolutions:[]})},'fixture@1');
 let tasks=(await db.query('SELECT * FROM tasks WHERE account_id=$1 ORDER BY title',[account])).rows;assert.equal(tasks.length,2);assert.ok(tasks.every(t=>t.status==='open'));
 const refund=tasks.find(t=>t.title==='Approve refund');
 const follow=await transaction(db,c=>upsertRecord(c,{...source,externalId:'follow',sourceCreatedAt:'2026-10-22T12:00:00Z',bodyText:'Please approve the refund.'}));
 await transaction(db,db=>applyTasks(db,{id:follow.recordId,account_id:account,current_revision_id:follow.revisionId!},'Please approve the refund.',{requests:[{...requests[0],existing_task_id:refund.id}],resolutions:[]},true));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM tasks WHERE account_id=$1',[account])).rows[0].n,2);
 const uncertain=await transaction(db,c=>upsertRecord(c,{...source,externalId:'uncertain',sourceCreatedAt:'2026-10-23T12:00:00Z',bodyText:'It might have been approved.'}));
 await transaction(db,db=>applyTasks(db,{id:uncertain.recordId,account_id:account,current_revision_id:uncertain.revisionId!},'It might have been approved.',{requests:[],resolutions:[{task_id:refund.id,quote:'might have been approved',status:'uncertain'}]},false));
 assert.equal((await db.query('SELECT status FROM tasks WHERE id=$1',[refund.id])).rows[0].status,'uncertain');
 const resolved=await transaction(db,c=>upsertRecord(c,{...source,externalId:'resolved',sourceCreatedAt:'2026-10-24T12:00:00Z',bodyText:'The refund was approved.'}));
 await transaction(db,db=>applyTasks(db,{id:resolved.recordId,account_id:account,current_revision_id:resolved.revisionId!},'The refund was approved.',{requests:[],resolutions:[{task_id:refund.id,quote:'The refund was approved.',status:'done'}]},false));
 const done=(await db.query('SELECT * FROM tasks WHERE id=$1',[refund.id])).rows[0];assert.equal(done.status,'done');assert.equal(done.resolution_evidence_record_id,resolved.recordId);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM task_records WHERE task_id=$1 AND relationship='follow-up'",[refund.id])).rows[0].n,1);
 assert.equal((await db.query("SELECT status FROM tasks WHERE account_id=$1 AND title='Send receipt'",[account])).rows[0].status,'open');
 await assert.rejects(transaction(db,db=>applyTasks(db,{id:follow.recordId,account_id:account,current_revision_id:follow.revisionId!},'Please approve the refund.',{requests:[{...requests[0],quote:'Invented evidence'}],resolutions:[]},true)),/exact source/);
 await assert.rejects(transaction(db,db=>applyTasks(db,{id:follow.recordId,account_id:account,current_revision_id:follow.revisionId!},'Please approve the refund.',{requests:[{...requests[0],existing_task_id:randomUUID()}],resolutions:[]},true)),/consolidation/);
}));
test('source action quotes support personal relevance without bypassing group participation',{skip:!url},()=>fixture(async(db,account)=>{
 for(const group of [false,true]){
  const body='Your order is confirmed.';
  const source={accountId:account,externalId:group?'group-confirmation':'confirmation',kind:group?'slack-message':'email',bodyText:body,rawPayload:{},...(group?{conversation:{externalId:'nonpersonal-group',kind:'group',title:'Group'}}:{})};
  const record=await transaction(db,c=>upsertRecord(c,source));const job=await enqueue(db,account,record.recordId,record.revisionId!);
  await classifyJob(db,job,{classify:async()=>({labels:['personal','update'],personal_evidence:body,reason:'Response to an order action',confidence:0.8})},'fixture@1');
  const labels=(await db.query('SELECT label FROM record_labels WHERE record_id=$1',[record.recordId])).rows.map(r=>r.label);assert.equal(labels.includes('personal'),!group);
 }
}));
test('Slack task consolidation cannot cross unrelated channel threads',{skip:!url},()=>fixture(async(db,account)=>{
 const {relatedTasks,applyTasks}=await import('../packages/database/src/task-extraction.js');
 const source={accountId:account,externalId:'thread-parent',kind:'slack-message',conversation:{externalId:'channel',kind:'channel',title:'Channel'},bodyText:'Please send the receipt.',rawPayload:{},sourceCreatedAt:'2026-10-24T12:00:00Z',slack:{channelId:'channel',messageTs:'1792843200.000000',threadTs:null},participants:[{externalId:'other',isSelf:false,role:'author'}]};
 const original=await transaction(db,c=>upsertRecord(c,source));
 await transaction(db,db=>applyTasks(db,{id:original.recordId,account_id:account,current_revision_id:original.revisionId!},source.bodyText,{requests:[{title:'Send receipt',description:'Send the receipt',quote:source.bodyText,due_at:null,existing_task_id:null}],resolutions:[]},true));
 const same=await transaction(db,c=>upsertRecord(c,{...source,externalId:'reply-same',slack:{channelId:'channel',messageTs:'1792843201.000000',threadTs:'1792843200.000000'}}));
 assert.equal((await relatedTasks(db,same.recordId,account)).length,1);
 const unrelated=await transaction(db,c=>upsertRecord(c,{...source,externalId:'reply-other',slack:{channelId:'channel',messageTs:'1792843202.000000',threadTs:'1792843100.000000'}}));
 assert.equal((await relatedTasks(db,unrelated.recordId,account)).length,0);
}));
