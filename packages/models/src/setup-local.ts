import {readFile,writeFile,chmod} from 'node:fs/promises';
import {chromium} from 'playwright';
import {loadConfig} from '@personal-context/config';
import {createModelAdapters} from './index.js';
const endpoint='http://127.0.0.1:11434';
const embeddingName=process.env.LOCAL_EMBEDDING_MODEL??'embeddinggemma:latest';
const visionName=process.env.LOCAL_VISION_MODEL??'gemma3:4b';
const tags=await (await fetch(endpoint+'/api/tags',{signal:AbortSignal.timeout(10000)})).json() as {models:{name:string;digest:string}[]};
function pin(name:string){const model=tags.models.find(m=>m.name===name);if(!model)throw new Error('Required local model is not installed');const digest='sha256:'+model.digest.replace(/^sha256:/,'');if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('Invalid installed model digest');return digest;}
const embeddingVersion=pin(embeddingName),visionVersion=pin(visionName);
const probe=await fetch(endpoint+'/api/embed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:embeddingName,input:['Local setup verification'],truncate:false}),signal:AbortSignal.timeout(60000)});
if(!probe.ok)throw new Error('Embedding setup verification failed');const dimensions=((await probe.json()) as {embeddings:number[][]}).embeddings[0].length;
const settings={EMBEDDING_ADAPTER:'ollama',EMBEDDING_ENDPOINT:endpoint,EMBEDDING_MODEL:embeddingName,EMBEDDING_VERSION:embeddingVersion,EMBEDDING_DIMENSIONS:String(dimensions),CLASSIFIER_ADAPTER:'ollama',CLASSIFIER_ENDPOINT:endpoint,CLASSIFIER_MODEL:visionName,CLASSIFIER_VERSION:visionVersion,VISION_ADAPTER:'ollama',VISION_ENDPOINT:endpoint,VISION_MODEL:visionName,VISION_VERSION:visionVersion};
const config=loadConfig({...process.env,...settings}),models=createModelAdapters(config);
const vectors=await models.embed(['A local setup check','A receipt for dinner']);if(vectors.length!==2)throw new Error('Embedding validation failed');console.log('Local embeddings passed:',dimensions,'dimensions');
const newsletter=await models.classify('A routine gardening newsletter: this month, learn about growing tomatoes. Read our latest articles.');if(!newsletter.labels.includes('background')||newsletter.labels.includes('blocking'))throw new Error('Newsletter classification failed');console.log('Local newsletter classification passed');
const request='Please approve the refund. Please send the receipt.';const tasks=await models.extractTasks(JSON.stringify({source:request,related_tasks:[]}));if(tasks.requests.length!==2||tasks.resolutions.length||tasks.requests.some(t=>!request.includes(t.quote)))throw new Error('Local task evidence verification failed');console.log('Local task extraction passed');
const browser=await chromium.launch({headless:true});let screenshot:Buffer;
try{const page=await browser.newPage({viewport:{width:640,height:480}});await page.setContent('<html><body style="background:white;color:black;font:28px Arial;padding:35px"><h1>TEST RECEIPT</h1><p>Example Cafe</p><p>Coffee 5.00</p><p>Sandwich 7.34</p><h2>Total 12.34</h2></body></html>');screenshot=await page.screenshot({type:'png'});}finally{await browser.close();}
const vision=await models.describe({mimeType:'image/png',base64:screenshot.toString('base64')});if(!vision.description.trim()||!vision.ocr.includes('12.34'))throw new Error('Local receipt OCR verification failed');console.log('Local receipt description and OCR passed');
let env=await readFile('.env','utf8');for(const [key,value]of Object.entries(settings)){const line=key+'='+value;const pattern=new RegExp('^'+key+'=.*$','m');env=pattern.test(env)?env.replace(pattern,line):env.trimEnd()+'\n'+line+'\n';}await writeFile('.env',env,{mode:0o600});await chmod('.env',0o600);
console.log('Pinned local model settings saved privately; restart API and worker to enable them.');
