import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const origin='http://127.0.0.1:5174';
const child=spawn(process.execPath,['../../node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort'],{cwd:new URL('../apps/web/',import.meta.url),stdio:'pipe'});
let browser;
try {
 let ready=false;
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('UI server exited');try{ready=(await fetch(origin)).ok;}catch{}if(ready)break;await delay(100);}
 assert.ok(ready,'UI server available');
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let loggedIn=false,personal=false,revoked=false,created=false,retries=0,photoFailure=false,overviewFailure=false,emptyOverview=false,delayOverview=false,releaseOverview=null,retryConflict=false;
 const requests=[];
 const account='11111111-1111-4111-8111-111111111111';
 await page.context().route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.hostname==='photos.google.com')return route.fulfill({contentType:'text/html',body:'<h1>Fixture Photos Picker</h1>'});
  if(url.origin!==origin)return route.abort();
  const path=url.pathname;requests.push(path+url.search);if(!path.startsWith('/api/')&&!path.startsWith('/auth/'))return route.continue();
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/auth/setup')return json({configured:true});
  if(path==='/auth/session')return loggedIn?json({csrf_token:'fixture-csrf'}):json({error:'Unauthorized'},401);
  if(path==='/auth/login'){assert.equal(req.postDataJSON().password,'fixture-password');loggedIn=true;return json({csrf_token:'fixture-csrf'});}
  assert.ok(loggedIn);
  if(req.method()!=='GET')assert.equal(req.headers()['x-csrf-token'],'fixture-csrf');
  if(path==='/auth/logout'){loggedIn=false;return json({ok:true});}
  if(path==='/api/connections')return json({configured:{google:true,slack:false},accounts:[{id:account,provider:'google-photos',display_name:'Owner <script>alert(1)</script>',status:'active',provider_environment:'production'}]});
  if(path==='/api/photos/imports'){
   const original={id:'import-fixture',account_id:account,created_at:'2026-10-25T12:00:00Z',status:'importing',expires_at:new Date(Date.now()+60000).toISOString(),counts:{selected:2,downloaded:2,analyzed:0,keyword_indexed:1,classified:0,embedded:0},embedding_model_configured:false,error_code:null};
   if(url.searchParams.get('status')==='done')return json({imports:[],next_cursor:null});
   return json({imports:url.searchParams.get('cursor')?[{...original,id:'older-import'}]:[original,...Array.from({length:49},(_,i)=>({...original,id:'import-'+i}))],next_cursor:url.searchParams.get('cursor')?null:'page2'});
  }
  if(path===`/api/photos/${account}/sessions`)return photoFailure?json({error:'Selection unavailable; retry'},503):json({id:'import-fixture',picker_uri:'https://photos.google.com/picker/fixture'});
  if(path==='/api/operations/overview'){
   if(delayOverview)await new Promise(resolve=>{releaseOverview=resolve;});
   if(overviewFailure)return json({error:'Fixture service unavailable'},503);
   return json({storage:{database_bytes:emptyOverview?'0':'12582912',media_bytes:emptyOverview?'0':'1048576'},records:{total:emptyOverview?0:1003,deleted:0,pending_stale:emptyOverview?0:1},sources:emptyOverview?[]:[{account_id:account,provider:'google-photos',display_name:'Photos',status:'active',provider_environment:'production',count:2,last_import_at:'2026-10-25T12:00:00Z'},{account_id:'gmail-fixture',provider:'gmail',display_name:'Mail',status:'active',count:1001,last_import_at:null}],classifications:['personal','background','blocking','update','unorganized'].map(label=>({label,count:emptyOverview?0:10})),stages:emptyOverview?[]:[{stage:'ingest',status:'done',count:1},{stage:'embed',status:'failed',count:1}],streams:[{account_id:'gmail-fixture',stream_key:'mailbox',last_attempt_at:'2026-10-25T13:00:00Z',last_success_at:'2026-10-25T12:00:00Z',source_watermark_at:null,coverage_complete:false,last_job_status:'failed',error_code:'provider_unavailable'}],slack:[{account_id:'gmail-fixture',status:'disconnected',inbox_backlog:3,coverage_complete:false}]});
  }
  if(path==='/api/operations/jobs'||path==='/api/operations/failures'){
   if(url.searchParams.get('status')==='done')return json({items:[],next_cursor:null});
   const item={id:'job-fixture',entry_type:'job',account_id:account,created_at:'2026-10-25T12:00:00Z',stage:'embed',status:'failed',stream_key:'embed:fixture',attempt:5,max_attempts:5,error_code:'model_unavailable'};
   return json({items:url.searchParams.get('cursor')?[{...item,id:'older-job'}]:[item,...Array.from({length:49},(_,i)=>({...item,id:'job-'+i,...(path.endsWith('failures')?{entry_type:'import',stage:'photo',status:'expired'}:{})}))],next_cursor:url.searchParams.get('cursor')?null:'page2'});
  }
  if(path==='/api/operations/jobs/job-fixture/retry'){if(retryConflict)return json({error:'Stream has active work'},409);retries++;return json({queued:true});}
  if(path==='/api/operations/agents')return json({agents:created?[{id:'agent-fixture',name:'Test agent',revoked_at:revoked?'now':null,accounts:[account]}]:[]});
  if(path==='/api/agents'){assert.deepEqual(req.postDataJSON(),{name:'Test agent',accounts:[account]});created=true;return json({id:'agent-fixture',credential:'one-time-fixture-credential'});}
  if(path==='/api/agents/agent-fixture'){revoked=true;return json({ok:true});}
  if(path==='/api/operations/conversations')return json({conversations:[{id:'conversation-fixture',title:'Example group',kind:'group',personal_override:personal}],next_cursor:null});
  if(path==='/api/operations/conversations/conversation-fixture/personal'){personal=req.postDataJSON().personal;return json({personal_override:personal});}
  throw new Error('Unexpected browser request: '+path);
 });
 await page.goto(origin);await page.getByRole('heading',{name:'Owner sign in'}).waitFor();
 await page.getByLabel('Password',{exact:true}).fill('fixture-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 await page.getByText('1,003',{exact:true}).waitFor();assert.equal(await page.locator('#history-entries').count(),0);
 assert.ok(!requests.some(p=>p.startsWith('/api/operations/jobs')||p.startsWith('/api/photos/imports')));
 await page.getByText('12 MiB',{exact:true}).waitFor();await page.getByText('Labels overlap:',{exact:false}).waitFor();
 await page.getByText('Manual imports · no scheduled poll',{exact:true}).waitFor();await page.getByText('Latest poll job: failed · provider_unavailable',{exact:true}).waitFor();
 await page.getByRole('navigation').getByRole('link',{name:'Connections',exact:true}).click();
 await page.getByRole('heading',{name:'Source connections'}).waitFor();
 await page.getByText('Slack setup required:',{exact:false}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Connect Slack',exact:true}).isDisabled(),true);
 await page.getByText('Owner <script>alert(1)</script> · google-photos · active',{exact:true}).waitFor();
 assert.equal(await page.locator('#accounts script').count(),0);

 const popupReady=page.waitForEvent('popup');
 await page.getByRole('button',{name:'Choose photos'}).click();
 const popup=await popupReady;await popup.waitForURL('https://photos.google.com/picker/fixture');
 assert.equal(await popup.evaluate(()=>window.opener),null);await popup.close();
 await page.getByRole('link',{name:'Open Google Photos Picker'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open Google Photos Picker'}).getAttribute('href'),'https://photos.google.com/picker/fixture');
 await page.evaluate(()=>{window.originalOpen=window.open;window.open=()=>null;});
 await page.getByRole('button',{name:'Choose photos'}).click();
 await page.getByText('Your browser blocked the new tab. Open the Picker here:',{exact:false}).waitFor();
 assert.equal(await page.locator('#accounts').getByRole('link',{name:'Open Google Photos Picker'}).getAttribute('href'),'https://photos.google.com/picker/fixture');
 await page.evaluate(()=>{window.open=window.originalOpen;});
 photoFailure=true;
 const failedPopupReady=page.waitForEvent('popup');
 await page.getByRole('button',{name:'Choose photos'}).click();const failedPopup=await failedPopupReady;
 await page.locator('#accounts').getByText('Selection unavailable; retry',{exact:true}).waitFor();
 assert.ok(failedPopup.isClosed());
 photoFailure=false;
 await page.getByRole('navigation').getByRole('link',{name:'Failures',exact:true}).click();
 await page.getByRole('button',{name:'Retry embed · job-fixture',exact:true}).waitFor();
 retryConflict=true;await page.getByRole('button',{name:'Retry embed · job-fixture',exact:true}).click();await page.getByText('Stream has active work',{exact:true}).waitFor();assert.equal(retries,0);
 retryConflict=false;await page.getByRole('button',{name:'Retry embed · job-fixture',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#content[aria-busy=true]'));assert.equal(retries,1);
 await page.getByRole('navigation').getByRole('link',{name:'Agent Access',exact:true}).click();
 await page.getByLabel('Agent name').fill('Test agent');await page.locator('input[name=account]').check();await page.getByRole('button',{name:'Create credential'}).click();await page.getByText('Copy this credential now: one-time-fixture-credential',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Revoke',exact:true}).click();await page.getByText('Test agent · revoked',{exact:true}).waitFor();assert.ok(revoked);
 await page.getByRole('navigation').getByRole('link',{name:'Personal Conversations',exact:true}).click();
 await page.getByLabel('Personal',{exact:true}).check();await page.getByText('Setting saved; reclassification queued.',{exact:true}).waitFor();assert.ok(personal);

 for(const [label,path] of [['Job History','jobs'],['Failures','failures'],['Photo Imports','imports']]){
  await page.getByRole('navigation').getByRole('link',{name:label,exact:true}).click();
  await page.locator('#history-entries > li').nth(49).waitFor();assert.equal(await page.locator('#history-entries > li').count(),50);
  assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Next',exact:true}).click();
  await page.getByText(path==='imports'?'older-import':'older-job',{exact:true}).waitFor();assert.equal(await page.locator('#history-entries > li').count(),1);
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  const position=page.url();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText(path==='imports'?'older-import':'older-job',{exact:true}).waitFor();assert.equal(page.url(),position);
  await page.reload();await page.getByText(path==='imports'?'older-import':'older-job',{exact:true}).waitFor();assert.equal(page.url(),position);
  await page.getByRole('button',{name:'Previous',exact:true}).click();await page.locator('#history-entries > li').nth(49).waitFor();
  await page.goBack();await page.getByText(path==='imports'?'older-import':'older-job',{exact:true}).waitFor();await page.goForward();await page.locator('#history-entries > li').nth(49).waitFor();
  if(path!=='failures'){
   await page.getByLabel('Status',{exact:true}).selectOption('done');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByText('No matching entries.',{exact:false}).waitFor();assert.ok(!page.url().includes('cursor='));
   await page.getByLabel('Status',{exact:true}).selectOption('');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.locator('#history-entries > li').nth(49).waitFor();
  }
  if(path==='imports')await page.getByText('selected: 2 · downloaded: 2 · analyzed: 0 · keyword_indexed: 1 · classified: 0 · embedded: 0',{exact:true}).first().waitFor();
 }
 await page.getByRole('navigation').getByRole('link',{name:'Job History',exact:true}).click();await page.locator('#history-entries > li').nth(49).waitFor();await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('older-job',{exact:true}).waitFor();
 const oldPage=page.url(),beforeRequests=requests.filter(p=>p.startsWith('/api/operations/jobs')).length;await page.waitForTimeout(5200);assert.equal(page.url(),oldPage);assert.equal(requests.filter(p=>p.startsWith('/api/operations/jobs')).length,beforeRequests);
 await page.getByRole('navigation').getByRole('link',{name:'Overview',exact:true}).click();await page.getByText('1,003',{exact:true}).waitFor();
 emptyOverview=true;await page.reload();await page.getByText('No connected sources yet.',{exact:false}).waitFor();assert.equal(await page.locator('progress').count(),5);assert.ok(!(await page.locator('#overview').textContent()).includes('NaN'));emptyOverview=false;
 overviewFailure=true;await page.reload();await page.getByText('Fixture service unavailable',{exact:true}).first().waitFor();overviewFailure=false;await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByText('1,003',{exact:true}).waitFor();
 // An old response must not replace a newer route.
 delayOverview=true;await page.reload();await page.getByText('Loading…',{exact:true}).waitFor();
 for(let i=0;i<50&&!releaseOverview;i++)await delay(20);
 await page.getByRole('navigation').getByRole('link',{name:'Job History',exact:true}).click();await page.locator('#history-entries > li').nth(49).waitFor();delayOverview=false;releaseOverview?.();await page.waitForTimeout(100);assert.equal(await page.getByRole('heading',{name:'Job History',exact:true}).count(),1);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Navigation',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Navigation',exact:true}).getAttribute('aria-expanded'),'true');
 await page.getByRole('navigation').getByRole('link',{name:'Overview',exact:true}).focus();await page.keyboard.press('Enter');await page.getByText('1,003',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Navigation',exact:true}).getAttribute('aria-expanded'),'false');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:'/private/tmp/operations-dashboard-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1050});await page.screenshot({path:'/private/tmp/operations-dashboard-overview.png',fullPage:true});
 await page.getByRole('button',{name:'Sign out'}).click();await page.getByRole('heading',{name:'Owner sign in'}).waitFor();assert.equal(await page.locator('#new-credential').count(),0);assert.ok(!(await page.locator('#app').textContent()).includes('one-time-fixture-credential'));
 assert.deepEqual(errors,[]);console.log('Dashboard browser smoke passed (provider responses mocked; no live OAuth).');
} finally {await browser?.close();child.kill('SIGTERM');}
