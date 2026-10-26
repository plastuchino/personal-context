import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {slackCallbackHandler} from '../apps/api/src/slack-callback.js';
test('Slack callback bridge forwards only its callback with owner cookie and a fixed dashboard redirect',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];let destination='http://127.0.0.1:5173/?connection=success';
 const request:typeof fetch=async(input,init)=>{calls.push({url:String(input),init});return new Response(null,{status:303,headers:{Location:destination}});};
 const server=createServer(slackCallbackHandler('http://127.0.0.1:3001','http://127.0.0.1:5173',request));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 try{
  assert.equal((await fetch(base+'/api/connections/gmail/callback?code=must-not-forward')).status,404);
  assert.equal((await fetch(base+'/api/connections/slack/callback',{method:'POST'})).status,405);assert.equal(calls.length,0);
  const response=await fetch(base+'/api/connections/slack/callback?code=fixture-code&state=fixture-state',{headers:{Cookie:'owner_session=fixture',Authorization:'Bearer do-not-forward'},redirect:'manual'});
  assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'http://127.0.0.1:5173/?connection=success');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  assert.equal(calls[0].url,'http://127.0.0.1:3001/api/connections/slack/callback?code=fixture-code&state=fixture-state');
  const headers=new Headers(calls[0].init?.headers);assert.equal(headers.get('Cookie'),'owner_session=fixture');assert.equal(headers.get('Authorization'),null);assert.equal(calls[0].init?.redirect,'manual');
  destination='https://untrusted.example/capture';const rejected=await fetch(base+'/api/connections/slack/callback?code=fixture',{redirect:'manual'});assert.equal(rejected.status,502);assert.equal(rejected.headers.get('Location'),null);assert.ok(!(await rejected.text()).includes('untrusted.example')); 
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test('Slack callback bridge rejects an external API origin',()=>{
 assert.throws(()=>slackCallbackHandler('https://example.test','http://127.0.0.1:5173'),/loopback/);
});
