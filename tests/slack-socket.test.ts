import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { socketController, silentSlackLogger } from '../packages/connectors/src/slack-socket.js';
class FakeSocket extends EventEmitter {
 starts=0;
 async start(){this.starts++;this.emit('connected');}
 async disconnect(){this.emit('disconnected');}
}
test('Socket Mode acknowledges only after durable receipt and retries refreshed connections',async()=>{
 const socket=new FakeSocket(), order:string[]=[],states:string[]=[];let scheduled:(()=>void)|undefined;
 const controller=socketController({token:'xapp-test',factory:()=>socket,status:async state=>{states.push(state);},retry:(run,delay)=>{assert.ok(delay<=60000);scheduled=run;return()=>{};},receive:async e=>{order.push('persisted');await e.ack();}});
 await controller.start();socket.emit('slack_event',{body:{},envelope_id:'env',ack:async()=>{order.push('ack');}});await controller.flush();assert.deepEqual(order,['persisted','ack']);
 socket.emit('disconnected');assert.ok(scheduled);scheduled!();await controller.flush();assert.equal(socket.starts,2);assert.ok(states.includes('disconnected'));await controller.stop();
});
test('missing or revoked app token is observable and source payload is never logged',async()=>{
 const states:string[]=[];const missing=socketController({token:null,status:async(_,code)=>{if(code)states.push(code);},receive:async()=>{}});await missing.start();assert.ok(states.includes('missing_app_token'));await missing.stop();
 const bad=new FakeSocket();bad.start=async()=>{throw {data:{error:'token_revoked'},token:'secret'};};
 const revoked=socketController({token:'xapp-secret',factory:()=>bad,status:async(_,code)=>{if(code)states.push(code);},receive:async()=>{}});await revoked.start();assert.ok(states.includes('app_token_rejected'));assert.ok(!states.join().includes('secret'));await revoked.stop();
 // Suppress SDK logging even if a dependency attempts to print its raw event/token.
 silentSlackLogger.error('private-source-body','xapp-secret');
});

test('persistence failure leaves delivery unacknowledged and records a gap',async()=>{
 const socket=new FakeSocket(),codes:string[]=[];let ack=false;
 const controller=socketController({token:'xapp-test',factory:()=>socket,status:async(_,code)=>{if(code)codes.push(code);},receive:async()=>{throw new Error('private body');}});
 await controller.start();socket.emit('slack_event',{body:{},envelope_id:'x',ack:async()=>{ack=true;}});await controller.flush();assert.equal(ack,false);assert.ok(codes.includes('event_persistence_failed'));await controller.stop();
});
