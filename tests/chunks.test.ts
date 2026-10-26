import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chunkText,sourceText} from '../packages/retrieval/src/chunks.js';
test('chunk boundaries retain exact offsets, overlap and Unicode characters',()=>{
 const text=('A receipt for groceries. 😀\n').repeat(200);const chunks=chunkText(text,128,16);
 assert.ok(chunks.length>2);assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1)!.end,text.length);
 for(let n=0;n<chunks.length;n++){const c=chunks[n];assert.equal(c.content,text.slice(c.start,c.end));assert.ok(c.content.length<=129);assert.ok(!/^[\uDC00-\uDFFF]/.test(c.content));assert.ok(!/[\uD800-\uDBFF]$/.test(c.content));if(n)assert.ok(c.start<chunks[n-1].end);}
});
test('empty source content has deterministic structured indexing input',()=>{
 const value=sourceText({kind:'financial-account',external_id:'account',title:'',body_text:'',raw_payload:{balance:'123.45'}});assert.equal(value.kind,'structured');assert.ok(value.text.includes('123.45'));assert.equal(chunkText(value.text).length,1);
});
