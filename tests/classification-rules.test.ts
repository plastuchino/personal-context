import {test} from 'node:test';
import assert from 'node:assert/strict';
import {participation,rollingParticipation,WINDOW_MS} from '../packages/classification/src/rules.js';
test('personal participation has exact inclusive thresholds and explicit overrides',()=>{
 assert.equal(participation(5,100,false,true).reason,'five-messages');
 assert.equal(participation(4,100,false,true).personal,false);
 assert.equal(participation(2,20,false,true).reason,'participation-ratio');
 assert.equal(participation(2,21,false,true).personal,false);
 assert.equal(participation(0,0,false,true).personal,false);
 assert.equal(participation(0,0,true,false).reason,'override');
 assert.equal(participation(2,20,false,false).personal,true);assert.equal(participation(2,20,false,false).coverageComplete,false);
 assert.throws(()=>participation(3,2,false,true),/Invalid/);
});
test('seven-day window excludes expired, deleted and future messages exactly',()=>{
 const now=new Date('2026-10-25T15:00:00Z'),cutoff=now.getTime()-WINDOW_MS;
 const messages=[{timestamp:new Date(cutoff).toISOString(),self:true},{timestamp:new Date(cutoff+1).toISOString(),self:true},{timestamp:now.toISOString(),self:false},{timestamp:new Date(now.getTime()+1).toISOString(),self:true},{timestamp:now.toISOString(),self:true,deleted:true}];
 assert.deepEqual(rollingParticipation(messages,now,false,false),{self:1,total:2,personal:true,reason:'participation-ratio',coverageComplete:false});
 assert.equal(rollingParticipation(messages,new Date(now.getTime()+WINDOW_MS+1),false,true).personal,false);
});
