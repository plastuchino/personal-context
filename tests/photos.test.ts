import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedMedia,photoClient} from '../packages/connectors/src/photos.js';
test('photo download limits cover declared and streaming sizes',async()=>{
 await assert.rejects(boundedMedia(new Response('large',{headers:{'Content-Length':'100'}}),4),/media_too_large/);
 await assert.rejects(boundedMedia(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(3));c.enqueue(new Uint8Array(3));c.close();}})),4),/media_too_large/);
 assert.equal((await boundedMedia(new Response('image'),5)).toString(),'image');
 await assert.rejects(boundedMedia(new Response('expired',{status:403}),10),/photo_download_expired/);
});
test('photo transport will not forward OAuth credentials to an arbitrary media host',async()=>{
 let calls=0;const client=photoClient(async()=>'secret',async()=>{calls++;return new Response('x');});
 await assert.rejects(client.download('https://evil.example/file','image/png',10),/Untrusted/);assert.equal(calls,0);
});
