import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/api/src/app.js';
import {digest} from '@personal-context/security';
import {randomBytes} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../packages/database/src/migrate.js';
import {receiveSlackEvent,persistThenAcknowledge,type SlackEventBody} from '../packages/database/src/slack-events.js';
const url=process.env.TEST_DATABASE_URL;
export async function installation(db:pg.Pool){
 const account=randomUUID();await db.query("INSERT INTO source_accounts(id,provider,external_account_id,display_name,status) VALUES($1,'slack',$2,'Slack test','active')",[account,account]);
 await db.query("INSERT INTO slack_connection_state(account_id,app_id,team_id,authorized_user_id) VALUES($1,$2,$3,'U1')",[account,'A'+account,'T'+account]);
 return account;
}
export function eventBody(account:string,id:string):SlackEventBody{return {type:'event_callback',api_app_id:'A'+account,team_id:'T'+account,event_id:id,authorizations:[{team_id:'T'+account,user_id:'U1',is_bot:false}],event:{type:'message',channel:'C1',ts:'1792929600.000001',event_ts:'1792929600.000001',user:'U1',text:'hello'}};}
test('Slack receipt durably routes, deduplicates and queues before acknowledgment',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=await installation(db);const body=eventBody(account,'E1');let acknowledged=false;
  await persistThenAcknowledge(db,account,'envelope',body,async()=>{
   assert.equal((await db.query('SELECT count(*)::int AS n FROM slack_event_inbox WHERE account_id=$1',[account])).rows[0].n,1);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE account_id=$1 AND stage='slack-event'",[account])).rows[0].n,1);acknowledged=true;
  });assert.equal(acknowledged,true);
  assert.equal(await receiveSlackEvent(db,account,'redelivery',body),'duplicate');
  assert.equal(await receiveSlackEvent(db,account,'bad',{...body,event_id:'E2',authorizations:[{team_id:body.team_id,user_id:'OTHER',is_bot:false}]}),'ignored');
  assert.equal(await receiveSlackEvent(db,account,'bad',{...body,event_id:'E3',api_app_id:'OTHER'}),'ignored');
  // A restarted process sees the durable inbox and queued job, independent of redelivery.
  const restarted=new pg.Pool({connectionString:url});
  try{assert.equal((await restarted.query("SELECT status FROM slack_event_inbox WHERE account_id=$1 AND event_id='E1'",[account])).rows[0].status,'queued');}finally{await restarted.end();}
  let ackFailed=false;
  const broken={connect:async()=>{throw new Error('database unavailable');}} as unknown as pg.Pool;
  await assert.rejects(persistThenAcknowledge(broken,account,'fail',{...body,event_id:'E4'},async()=>{ackFailed=true;}),/database unavailable/);
  assert.equal(ackFailed,false);
 }finally{await db.end();}
});

test('Slack app-token configuration is owner-only and encrypted',{skip:!url},async()=>{
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=await installation(db),key=randomBytes(32).toString('base64');
  const session=randomUUID(),csrf=randomUUID();await db.query("INSERT INTO owner_sessions(token_digest,csrf_digest,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(session),digest(csrf)]);
  const app=createApp(db,'http://127.0.0.1:5173',{encryptionKey:key});
  const path=`/api/connections/slack/${account}/socket-token`;
  assert.equal((await app.request(path,{method:'POST'})).status,401);
  const response=await app.request(path,{method:'POST',headers:{Cookie:'owner_session='+session,Origin:'http://127.0.0.1:5173','X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({app_token:'xapp-private-test-token'})});
  assert.equal(response.status,200);assert.equal((await response.json()).configured,true);
  const stored=(await db.query('SELECT e.ciphertext FROM encrypted_credentials e JOIN slack_connection_state s ON s.app_credential_ref=e.id WHERE s.account_id=$1',[account])).rows[0];assert.ok(!stored.ciphertext.includes('xapp-private-test-token'));
 }finally{await db.end();}
});

test('Slack edits, deletions and stale reconciliation share ordered durable processing',{skip:!url},async()=>{
 const {claim}=await import('../packages/database/src/jobs.js');
 const {processSlackEvent}=await import('../packages/database/src/slack-processing.js');
 const {transaction,upsertRecord}=await import('../packages/database/src/records.js');
 const {slackRecord}=await import('../packages/connectors/src/slack.js');
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=await installation(db);
  async function deliver(id:string,event:NonNullable<SlackEventBody['event']>){
   await receiveSlackEvent(db,account,id,{...eventBody(account,id),event});
   const job=await claim(db,120,{accountId:account,stages:['slack-event']});assert.ok(job);await processSlackEvent(db,job);
  }
  const original={type:'message',channel:'C1',user:'U1',ts:'1792929600.000001',event_ts:'1792929600.000001',text:'original'};
  await deliver('create',original);
  const changed={...original,text:'edited',edited:{ts:'1792930000.000001'}};
  await deliver('edit',{type:'message',subtype:'message_changed',channel:'C1',ts:'1792930000.000001',event_ts:'1792930000.000001',message:changed});
  let row=(await db.query('SELECT r.*,v.body_text FROM records r LEFT JOIN record_revisions v ON v.id=r.current_revision_id WHERE r.account_id=$1',[account])).rows[0];assert.equal(row.body_text,'edited');
  const stale=await transaction(db,c=>upsertRecord(c,slackRecord(account,{id:'C1'},original,'U1')));assert.equal(stale.changed,false);
  await deliver('delete',{type:'message',subtype:'message_deleted',channel:'C1',ts:'1792930500.000001',event_ts:'1792930500.000001',deleted_ts:original.ts});
  await transaction(db,c=>upsertRecord(c,slackRecord(account,{id:'C1'},changed,'U1')));
  row=(await db.query('SELECT deleted_at FROM records WHERE id=$1',[row.id])).rows[0];assert.ok(row.deleted_at);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM record_revisions v JOIN records r ON v.record_id=r.id WHERE r.account_id=$1',[account])).rows[0].n,2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_jobs WHERE account_id=$1 AND stage='reclassify'",[account])).rows[0].n,3);
  // A delete received before the original is still authoritative.
  await deliver('early-delete',{type:'message',subtype:'message_deleted',channel:'C1',ts:'300.000001',event_ts:'300.000001',deleted_ts:'100.000001'});
  await deliver('late-create',{...original,ts:'100.000001',event_ts:'100.000001'});
  assert.ok((await db.query("SELECT deleted_at FROM records WHERE account_id=$1 AND external_id='C1:100.000001'",[account])).rows[0].deleted_at);
 }finally{await db.end();}
});

test('Slack reconciliation revisits older threads and retains uncertain outage coverage',{skip:!url},async()=>{
 const {claim,schedule}=await import('../packages/database/src/jobs.js');
 const {reconcileSlackPage}=await import('../packages/database/src/slack-reconciliation.js');
 const db=new pg.Pool({connectionString:url});
 try{
  await migrate(db);const account=await installation(db);
  await db.query("UPDATE slack_connection_state SET gap_started_at=now()-interval '1 hour' WHERE account_id=$1",[account]);
  await db.query("INSERT INTO sync_state(account_id,stream_key) VALUES($1,'channel:C1')",[account]);
  await db.query("INSERT INTO slack_threads(account_id,channel_id,thread_ts) VALUES($1,'C1','1.000001')",[account]);
  await schedule(db,['slack']);const job=await claim(db,120,{accountId:account,stages:['ingest']});assert.ok(job);
  const calls:string[]=[];const get=async(path:string,params?:Record<string,string|undefined>)=>{
   calls.push(path);if(path==='/conversations.history')return {ok:true,messages:[]};
   assert.equal(params?.ts,'1.000001');return {ok:true,messages:[{ts:'1792929900.000001',thread_ts:'1.000001',text:'missed reply',user:'U1'}]};
  };
  assert.equal(await reconcileSlackPage(db,job,get,30),false);
  assert.equal(await reconcileSlackPage(db,job,get,30),true);
  assert.deepEqual(calls,['/conversations.history','/conversations.replies']);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM records WHERE account_id=$1 AND external_id='C1:1792929900.000001'",[account])).rows[0].n,1);
  const coverage=(await db.query('SELECT gap_started_at,last_reconciled_at,coverage_complete FROM slack_connection_state WHERE account_id=$1',[account])).rows[0];assert.ok(coverage.gap_started_at);assert.ok(coverage.last_reconciled_at);assert.equal(coverage.coverage_complete,false);
  // Retention-limited sweeps cannot establish complete participation coverage.
  await db.query("UPDATE sync_state SET next_check_at=now() WHERE account_id=$1",[account]);await schedule(db,['slack']);const next=await claim(db,120,{accountId:account,stages:['ingest']});assert.ok(next);
  const limited=async()=>({ok:true,messages:[],is_limited:true});
  while(!await reconcileSlackPage(db,next,limited,30)){}
  assert.equal((await db.query("SELECT coverage_complete FROM sync_state WHERE account_id=$1 AND stream_key='channel:C1'",[account])).rows[0].coverage_complete,false);
 }finally{await db.end();}
});
