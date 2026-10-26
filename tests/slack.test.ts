import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slackConversations, slackMessages, slackTimestamp } from '../packages/connectors/src/slack.js';
test('Slack discovery preserves pagination and accessible conversation types', async () => {
 let called:unknown;
 const result=await slackConversations(async(path,params)=>{called={path,params};return {ok:true,channels:[{id:'C1'}],response_metadata:{next_cursor:'more'}};},'page');
 assert.equal(result.nextCursor,'more');assert.equal(result.conversations[0].id,'C1');assert.ok(JSON.stringify(called).includes('private_channel,im,mpim'));
});
test('Slack backfill keeps exact message IDs and marks incomplete coverage', async()=>{
 const get=async()=>({ok:true,messages:[{ts:'1792929600.000001',user:'SELF',text:'hello',reply_count:2}],response_metadata:{next_cursor:'more'}});
 const result=await slackMessages(get,'account',{id:'C1'},'SELF',{oldest:'1792324800.000000',latest:'1792929601.000000'});
 assert.equal(result.coverage.complete,false);assert.equal(result.records[0].externalId,'C1:1792929600.000001');assert.equal(result.records[0].participants?.[0].isSelf,true);assert.equal(result.threadIds[0],'1792929600.000001');
 assert.equal(slackTimestamp('1792929600.123456'),'2026-10-25T12:00:00.123Z');
});
test('Slack inaccessible conversations fail explicitly and retention limits remain incomplete',async()=>{
 await assert.rejects(slackMessages(async()=>({ok:false,error:'not_in_channel'}),'a',{id:'C'},'U',{oldest:'1.000000',latest:'2.000000'}),/source_inaccessible/);
 const limited=await slackMessages(async()=>({ok:true,messages:[],is_limited:true}),'a',{id:'C'},'U',{oldest:'1.000000',latest:'2.000000'});
 assert.equal(limited.coverage.complete,false);assert.equal(limited.coverage.limited,true);
});
test('Slack thread queries preserve parent and pagination',async()=>{
 let params:unknown;
 const result=await slackMessages(async(path,p)=>{assert.equal(path,'/conversations.replies');params=p;return {ok:true,messages:[{ts:'20.000001',thread_ts:'1.000001',text:'reply'}]};},'a',{id:'C'},'U',{oldest:'10.000000',latest:'30.000000'},'page','1.000001');
 assert.equal(result.records[0].slack?.threadTs,'1.000001');assert.ok(JSON.stringify(params).includes('page'));
});
