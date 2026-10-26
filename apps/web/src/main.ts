import './style.css';

const root=document.querySelector<HTMLDivElement>('#app');
if(!root)throw new Error('Missing application root');
const routes=[['/overview','Overview'],['/sources','Sources'],['/logs/jobs','Job History'],['/logs/failures','Failures'],['/logs/imports','Photo Imports'],['/settings/connections','Connections'],['/settings/agents','Agent Access'],['/settings/conversations','Personal Conversations']];
const icons=['<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>','<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>','<path d="M5 3h14v18H5zM9 8h6M9 12h6M9 16h4"/>','<path d="m12 3 10 18H2Z M12 9v5m0 3h.01"/>','<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>','<path d="m9 15 6-6M8 10l-3 3a4 4 0 0 0 6 6l3-3m-4-8 3-3a4 4 0 0 1 6 6l-3 3"/>','<path d="M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7Z M9 12l2 2 4-4"/>','<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0Z M7 10h10m-10 4h6"/>'];
root.innerHTML=`<header class="app-header"><a class="brand" href="#/overview"><span class="brand-mark">pc</span>Personal context <span class="muted">/ Operations</span></a><button id="logout" hidden>Sign out</button></header>
<p id="notice" role="status"></p><section id="login" class="panel login-panel" hidden><p class="eyebrow">PRIVATE WORKSPACE</p><h1>Owner sign in</h1><p id="setup" hidden>First, run <code>npm run owner:setup</code> in the project terminal to choose your password. Then sign in here.</p><form id="login-form"><label>Password<input id="password" type="password" autocomplete="current-password" required minlength="12" maxlength="1024"></label><button>Sign in</button></form></section>
<div id="dashboard" class="app-layout" hidden><button id="menu" aria-controls="navigation" aria-expanded="false">Navigation</button><nav id="navigation" aria-label="Operations"><p class="eyebrow">WORKSPACE</p>${routes.map(([path,label],i)=>`${i===2?'<p class="eyebrow nav-group">LOGS</p>':i===5?'<p class="eyebrow nav-group">SETTINGS</p>':''}<a href="#${path}"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[i]}</svg>${label}</a>`).join('')}<p class="sidebar-foot">Your data, connected.<br>Owner access only.</p></nav><main id="content" tabindex="-1"></main></div>`;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
let csrf='',epoch=0;
let refreshTimer:ReturnType<typeof setInterval>|undefined;
let accountsCache:Account[]=[];
interface Account {id:string;provider:string;display_name:string;status:string;provider_environment:string}
function notice(message:string){el('notice').textContent=message;}
function errorText(error:unknown){return error instanceof Error?error.message:'Request failed';}
function report(error:unknown){if(!(error instanceof DOMException&&error.name==='AbortError'))notice(errorText(error));}
async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
 const started=epoch;
 const response=await fetch(path,{method,credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(method==='GET'?{}:{'X-CSRF-Token':csrf})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const data=await response.json();
 if(started!==epoch)throw new DOMException('Screen changed','AbortError');
 if(!response.ok){if(response.status===401)showLogin();throw new Error(data.error??'Request failed');}
 return data as T;
}
function button(label:string,action:()=>Promise<void>){
 const b=document.createElement('button');b.textContent=label;
 b.onclick=async()=>{b.disabled=true;try{await action();}catch(error){report(error);}finally{b.disabled=false;}};return b;
}
function linkTo(label:string,path:string){const a=document.createElement('a');a.textContent=label;a.href='#'+path;return a;}
function showLogin(){epoch++;csrf='';accountsCache=[];clearInterval(refreshTimer);el('content').replaceChildren();el('dashboard').hidden=true;el('logout').hidden=true;el('login').hidden=false;}
function screen(){const [path,query='']=location.hash.slice(1).split('?');return {path:routes.some(([r])=>r===path)?path:'/overview',query:new URLSearchParams(query)};}
function navigate(path:string,query=new URLSearchParams()){const hash='#'+path+(query.size?'?'+query:'');if(location.hash===hash)void renderScreen();else location.hash=hash;}
function heading(title:string,description:string){el('content').innerHTML=`<div class="page-heading"><p class="eyebrow">OPERATIONS</p><h1></h1><p></p></div>`;el('content').querySelector('h1')!.textContent=title;el('content').querySelector('.page-heading > p:last-child')!.textContent=description;}
function node(tag:string,text:string,className=''){const n=document.createElement(tag);n.textContent=text;n.className=className;return n;}
function panel(title:string){const p=node('section','','panel');p.append(node('h2',title));return p;}
function table(title:string,rows:Record<string,unknown>[]){
 const section=panel(title);
 if(!rows.length){section.append(node('p','No observations yet','empty'));return section;}
 const wrap=node('div','','table-wrap');const t=document.createElement('table');t.setAttribute('aria-label',title);
 const keys=Object.keys(rows[0]);const head=t.createTHead().insertRow();
 for(const key of keys){const th=document.createElement('th');th.scope='col';th.textContent=key.replaceAll('_',' ');head.append(th);}
 const body=t.createTBody();for(const row of rows){const tr=body.insertRow();for(const key of keys){const td=tr.insertCell();td.textContent=row[key]===null||row[key]===undefined?'Not observed':String(row[key]);}}
 wrap.append(t);section.append(wrap);return section;
}
function bytes(value:string){const n=Number(value);if(!n)return '0 B';const power=Math.min(Math.floor(Math.log(n)/Math.log(1024)),4);return `${(n/1024**power).toLocaleString(undefined,{maximumFractionDigits:1})} ${['B','KiB','MiB','GiB','TiB'][power]}`;}
function ago(value:unknown){if(!value)return 'Not observed';const ms=Date.parse(String(value));if(!Number.isFinite(ms))return 'Not observed';const seconds=Math.max(0,Math.floor((Date.now()-ms)/1000));return seconds<60?`${seconds}s ago`:seconds<3600?`${Math.floor(seconds/60)}m ago`:seconds<86400?`${Math.floor(seconds/3600)}h ago`:`${Math.floor(seconds/86400)}d ago`;}
function when(value:unknown){return value?new Date(String(value)).toLocaleString():'Not observed';}
function observation(label:string,value:unknown){const p=node('p',label+': ');const t=node('span',ago(value));t.title=when(value);p.append(t);return p;}
interface Overview {storage:{database_bytes:string;media_bytes:string};records:{total:number;deleted:number;pending_stale:number};sources:(Account&{account_id:string;count:number;last_import_at:string|null})[];classifications:{label:string;count:number}[];stages:{stage:string;status:string;count:number}[];streams:Record<string,unknown>[];slack:Record<string,unknown>[]}
function accountName(id:unknown){const a=accountsCache.find(a=>a.id===id);return a?`${a.display_name} · ${a.provider}`:String(id??'Unknown source');}
async function overview(details=false){
 const data=await api<Overview>('/api/operations/overview');const target=el('overview');target.replaceChildren();
 if(details){
  target.append(table('Coverage and freshness',data.streams.map(s=>({source:accountName(s.account_id),stream:s.stream_key,enabled:s.enabled,coverage_start:when(s.coverage_start),coverage_end:when(s.coverage_end),coverage_complete:s.coverage_complete,coverage_gap:when(s.coverage_gap_at),last_attempt:when(s.last_attempt_at),last_success:when(s.last_success_at),provider_watermark:when(s.source_watermark_at),next_check:when(s.next_check_at),job_status:s.last_job_status,error:s.error_code}))),table('Slack event delivery',data.slack.map(s=>({...s,account_id:accountName(s.account_id)}))));return;
 }
 const cards=node('div','','metric-grid');
 for(const [label,value,detail] of [['Active records',data.records.total.toLocaleString(),'Across all connected sources'],['Database storage',bytes(data.storage.database_bytes),'Physical database size, including media'],['Media storage',bytes(data.storage.media_bytes),'Included in database storage'],['Processing backlog',data.stages.filter(s=>['queued','running'].includes(s.status)).reduce((n,s)=>n+s.count,0).toLocaleString(),'Queued and running jobs']]){const card=panel(label);card.classList.add('metric');card.append(node('p',value,'metric-value'),node('p',detail,'muted'));cards.append(card);}target.append(cards);
 const split=node('div','','overview-grid'),sourcePanel=panel('Data by source');sourcePanel.append(node('p','Active records across the full dataset','muted'));
 const providers=['gmail','slack','calendar','capital-one','google-photos'];
 for(const provider of providers){const count=data.sources.filter(s=>s.provider===provider).reduce((sum,s)=>sum+s.count,0),share=data.records.total?count/data.records.total*100:0;const row=node('div','','distribution');row.append(node('span',provider),node('strong',`${count.toLocaleString()} · ${share.toFixed(1)}%`));const bar=document.createElement('progress');bar.max=100;bar.value=share;bar.setAttribute('aria-label',`${provider} share`);row.append(bar);sourcePanel.append(row);}
 const classification=panel('Classification');classification.append(node('p','Labels overlap: a record can belong to more than one category.','muted'));
 for(const label of ['personal','background','blocking','update','unorganized']){const row=node('div','','count-row');row.append(node('span',label),node('strong',String(data.classifications.find(c=>c.label===label)?.count??0)));classification.append(row);}
 const pending=node('div','','count-row pending');pending.append(node('span','Pending or stale'),node('strong',String(data.records.pending_stale)));classification.append(pending);split.append(sourcePanel,classification);target.append(split);
 const health=panel('Pipeline health');const failed=data.stages.filter(s=>s.status==='failed').reduce((n,s)=>n+s.count,0);health.append(node('p',`${failed} failed jobs across all stages. Ingestion, classification, and indexing are independent.`,failed?'attention':'muted'),linkTo('Inspect failures','/logs/failures'));
 const stages=[...new Set(data.stages.map(s=>s.stage))];health.append(table('Work by stage',stages.map(stage=>({stage,queued:data.stages.find(s=>s.stage===stage&&s.status==='queued')?.count??0,running:data.stages.find(s=>s.stage===stage&&s.status==='running')?.count??0,failed:data.stages.find(s=>s.stage===stage&&s.status==='failed')?.count??0}))));target.append(health);
 const freshness=panel('Source freshness');freshness.append(node('p','Poll attempts, successful checks, and provider watermarks describe different observations.','muted'),linkTo('View source details','/sources'));const grid=node('div','','source-grid');
 for(const source of data.sources){const card=node('article','','source-card');card.append(node('h3',`${source.display_name} · ${source.provider}`),node('p',`Authorization: ${source.status}${source.provider_environment==='sandbox'?' · sandbox':''}`,'muted'));
 if(source.provider==='google-photos'){card.append(node('p','Manual imports · no scheduled poll','badge'),observation('Last import',source.last_import_at));}
 else {const streams=data.streams.filter(s=>s.account_id===source.account_id);if(!streams.length)card.append(node('p','No polls observed','muted'));
 for(const stream of streams){card.append(node('h4',String(stream.stream_key)),observation('Last poll attempt',stream.last_attempt_at),observation('Last successful poll',stream.last_success_at),observation('Provider watermark',stream.source_watermark_at),node('p',`Coverage: ${stream.coverage_complete?'complete':'incomplete'}${stream.coverage_gap_at?' · gap detected':''}`),node('p',`Latest poll job: ${stream.last_job_status??'Not observed'}${stream.error_code?' · '+stream.error_code:''}`,stream.last_job_status==='failed'?'attention':'muted'));}}
 const socket=data.slack.find(s=>s.account_id===source.account_id);if(socket)card.append(node('p',`Slack delivery: ${socket.status} · ${socket.inbox_backlog} queued · coverage ${socket.coverage_complete?'complete':'incomplete'}`,socket.status!=='connected'?'attention':'muted'));grid.append(card);}
 if(!data.sources.length)grid.append(node('p','No connected sources yet. Add a connection in Settings.','empty'));freshness.append(grid);target.append(freshness);
}
async function connections() {
 const data=await api<{accounts:Account[];configured:{google:boolean;slack:boolean};setup_required?:{google:string[];slack:string[]}}>('/api/connections');

 const connect=el('connect');connect.replaceChildren();
 for(const [provider,label] of [['gmail','Gmail'],['calendar','Calendar'],['google-photos','Google Photos'],['slack','Slack']]) {
  const b=button(`Connect ${label}`,async()=>{const result=await api<{authorization_url:string}>(`/api/connections/${provider}/start`,'POST',{});window.location.assign(result.authorization_url);});
  b.disabled=!(provider==='slack'?data.configured.slack:data.configured.google);connect.append(b);
  if(provider==='slack'&&b.disabled){const hint=document.createElement('p');hint.className='basis-full text-sm text-slate-400';hint.textContent='Slack setup required: '+(data.setup_required?.slack??['SLACK_CLIENT_ID','SLACK_CLIENT_SECRET','SLACK_APP_ID']).join(', ')+'. Add these to .env and restart the API.';connect.append(hint);}
 }
 const accounts=el('accounts');accounts.replaceChildren();
 for(const account of data.accounts) {
  const li=document.createElement('li');li.className='flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 p-4';
  const text=document.createElement('span');text.className='grow';text.textContent=`${account.display_name} · ${account.provider} · ${account.status}${account.provider_environment==='sandbox'?' · sandbox':''}`;li.append(text);
  if(['gmail','calendar','google-photos','slack'].includes(account.provider)) li.append(button('Reauthorize',async()=>{const result=await api<{authorization_url:string}>(`/api/connections/${account.provider}/start`,'POST',{});window.location.assign(result.authorization_url);}));
  if(account.provider==='google-photos'&&account.status==='active') {
   const pickerStatus=document.createElement('p');pickerStatus.className='basis-full text-sm text-teal-200';pickerStatus.setAttribute('role','status');
   li.append(button('Choose photos',async()=>{
    // Open during the click gesture, before awaiting the API, to avoid popup blocking.
    const picker=window.open('about:blank','_blank');
    if(picker)picker.opener=null;
    pickerStatus.textContent='Preparing Google Photos selection…';
    try {
     const result=await api<{id:string;picker_uri:string}>(`/api/photos/${account.id}/sessions`,'POST',{});
     const url=new URL(result.picker_uri);if(url.protocol!=='https:')throw new Error('Invalid Picker URL');
     const link=document.createElement('a');link.href=url.toString();link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open Google Photos Picker';link.className='underline';
     const opened=picker&&!picker.closed;
     if(opened)picker.location.replace(url.toString());
     pickerStatus.textContent=opened?'Picker opened in a new tab. Choose photos and confirm your selection there. ':'Your browser blocked the new tab. Open the Picker here: ';
     pickerStatus.append(link);
    } catch(error) {
     if(picker&&!picker.closed)picker.close();
     pickerStatus.textContent=error instanceof Error?error.message:'Unable to prepare Google Photos selection. Try again.';
     throw error;
    }
    pickerStatus.append(linkTo('View import progress','/logs/imports')); 
   }),pickerStatus);
  }
  accounts.append(li);
 }
 await socketSettings(data.accounts);
}
interface Agent {id:string;name:string;revoked_at:string|null;accounts:string[]}
interface Conversation {id:string;account_id:string;external_id:string;title:string|null;kind:string;personal_override:boolean}
async function agents() {
 const data=await api<{agents:Agent[]}>('/api/operations/agents');el('agents').replaceChildren();
 for(const agent of data.agents){const li=document.createElement('li');li.className='flex flex-wrap items-center gap-3';const text=document.createElement('span');text.textContent=`${agent.name} · ${agent.revoked_at?'revoked':`${agent.accounts.length} sources`}`;li.append(text);if(!agent.revoked_at)li.append(button('Revoke',async()=>{await api(`/api/agents/${agent.id}`,'DELETE');await agents();}));el('agents').append(li);}
}
async function socketSettings(accounts:Account[]) {
 for(const account of accounts.filter(a=>a.provider==='slack')){
  const form=document.createElement('form');form.className='mt-5 space-y-3';const label=document.createElement('label');label.textContent=`Slack Socket Mode app token for ${account.display_name}`;
  const input=document.createElement('input');input.type='password';input.autocomplete='off';input.placeholder='xapp-…';input.required=true;label.append(input);form.append(label);
  const submit=document.createElement('button');submit.textContent='Save app token';form.append(submit);
  const help=document.createElement('p');help.className='text-sm text-slate-400';help.textContent='Enable Socket Mode and user message subscriptions (channels, groups, im, mpim) in Slack. Token presence does not verify subscriptions; event delivery and coverage appear in pipeline health.';form.append(help);
  form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;const value=input.value;input.value='';try{await api(`/api/connections/slack/${account.id}/socket-token`,'POST',{app_token:value});notice('App token saved. Start npm run worker:slack to receive events.');}catch(error){notice(error instanceof Error?error.message:'Unable to save');}finally{submit.disabled=false;}};
  el('accounts').append(form);
 }

}

const agentForm=`<section class="panel"><h2>Agent access</h2><p>Credentials grant read-only access to selected sources. Copy a new credential once; it cannot be shown again.</p><form id="agent-form" class="stack"><label>Agent name<input name="name" maxlength="200" required></label><fieldset id="grants"><legend>Allowed sources</legend></fieldset><button>Create credential</button></form><p id="new-credential" role="status" class="break-all"></p><ul id="agents" class="stack"></ul></section>`;
async function agentSettings(){
 el('content').insertAdjacentHTML('beforeend',agentForm);
 for(const account of accountsCache){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.name='account';input.value=account.id;label.append(input,` ${account.display_name} · ${account.provider}`);el('grants').append(label);}
el<HTMLFormElement>('agent-form').onsubmit=async event=>{
 event.preventDefault();const form=event.currentTarget as HTMLFormElement;const data=new FormData(form);const submit=form.querySelector('button')!;submit.disabled=true;
 try{el('new-credential').textContent='';const result=await api<{credential:string}>('/api/agents','POST',{name:data.get('name'),accounts:data.getAll('account')});el('new-credential').textContent=`Copy this credential now: ${result.credential}`;await agents();}catch(e){notice(e instanceof Error?e.message:'Unable to create credential');}finally{submit.disabled=false;}
};
 await agents();
}
interface Conversation {id:string;account_id:string;external_id:string;title:string|null;kind:string;personal_override:boolean}
function paging(query:URLSearchParams,next:string|null,key='cursor'){
 const path=screen().path,controls=node('div','','pagination'),stack=query.getAll('prev');
 const previous=button('Previous',async()=>{const p=new URLSearchParams(query);p.delete('prev');const last=stack.pop();for(const entry of stack)p.append('prev',entry);if(last)p.set(key,last);else p.delete(key);navigate(path,p);});previous.disabled=!stack.length;
 const nextButton=button('Next',async()=>{const p=new URLSearchParams(query);p.append('prev',query.get(key)??'');p.set(key,next!);navigate(path,p);});nextButton.disabled=!next;
 controls.append(node('span','Up to 50 entries per page','muted'),previous,nextButton,button('Refresh',async()=>{await renderScreen();}),button('Newest',async()=>{const p=new URLSearchParams(query);p.delete(key);p.delete('prev');navigate(path,p);}));el('content').append(controls);
}
async function conversations(){
 const query=screen().query;const data=await api<{conversations:Conversation[];next_cursor:string|null}>('/api/operations/conversations'+(query.get('after')?'?after='+encodeURIComponent(query.get('after')!):''));
 el('content').insertAdjacentHTML('beforeend','<section class="panel"><h2>Personal conversations</h2><p>Explicitly mark a conversation personal. Changes queue reclassification.</p><ul id="conversations" class="stack"></ul></section>');
 for(const conversation of data.conversations){const li=document.createElement('li');li.className='flex flex-wrap items-center gap-3';const label=document.createElement('span');label.textContent=`${conversation.title??conversation.external_id} · ${conversation.kind}`;li.append(label);
 const check=document.createElement('input');check.type='checkbox';check.checked=conversation.personal_override;check.className='inline-block';const setting=document.createElement('label');setting.append(check,' Personal');li.append(setting);
 check.onchange=async()=>{check.disabled=true;try{await api(`/api/operations/conversations/${conversation.id}/personal`,'PUT',{personal:check.checked});notice('Setting saved; reclassification queued.');}catch(e){check.checked=!check.checked;notice(e instanceof Error?e.message:'Unable to save');}finally{check.disabled=false;}};
 el('conversations').append(li);}
 if(!data.conversations.length)el('conversations').textContent='No conversations found.';
 paging(query,data.next_cursor,'after');
}
interface Import {id:string;account_id:string;created_at:string;status:string;expires_at:string;counts:Record<string,number>;error_code:string|null;embedding_model_configured?:boolean}
interface HistoryEntry {id:string;entry_type:string;account_id:string;created_at:string;stage:string;status:string;stream_key:string|null;error_code:string|null;attempt:number|null;max_attempts:number|null}
function filters(kind:string,query:URLSearchParams){
 const form=document.createElement('form');form.className='filters panel';form.setAttribute('aria-label','History filters');
 const source=document.createElement('select');source.name='source';source.setAttribute('aria-label','Source');source.append(new Option('All sources',''));for(const a of accountsCache)source.append(new Option(`${a.display_name} · ${a.provider}`,a.id));source.value=query.get('source')??'';
 const status=document.createElement('select');status.name='status';status.setAttribute('aria-label','Status');status.append(new Option('All statuses',''));for(const value of kind==='imports'?['selecting','selected','importing','done','failed','expired']:kind==='failures'?['failed','expired']:['queued','running','done','failed'])status.append(new Option(value,value));status.value=query.get('status')??'';
 for(const [text,input] of [['Source',source],['Status',status]] as const){const label=node('label',text);label.append(input);form.append(label);}
 for(const [name,title] of [['from','From (UTC)'],['to','Until (UTC, exclusive)']]){const label=node('label',title),input=document.createElement('input');input.type='datetime-local';input.name=name;input.step='1';input.value=(query.get(name)??'').replace(/Z$/,'');label.append(input);form.append(label);}
 const submit=node('button','Apply filters');form.append(submit);
 form.onsubmit=e=>{e.preventDefault();const data=new FormData(form),p=new URLSearchParams();for(const name of ['source','status','from','to']){let value=String(data.get(name)??'');if(value){if(name==='from'||name==='to')value=value+(value.length===16?':00Z':'Z');p.set(name,value);}}navigate(screen().path,p);};el('content').append(form);
}
async function historyScreen(kind:'jobs'|'failures'|'imports'){
 const query=screen().query;filters(kind,query);const parameters=new URLSearchParams(query);parameters.delete('prev');
 const path=kind==='imports'?'/api/photos/imports':'/api/operations/'+kind;
 const data=await api<{items:HistoryEntry[];imports:Import[];next_cursor:string|null}>(path+'?'+parameters);
 const items=kind==='imports'?data.imports:data.items;
 const section=panel(kind==='imports'?'Google Photos imports':kind==='failures'?'Failure history':'Job history');
 section.append(node('p','Newest first by creation time. Legacy creation dates are approximate.','muted'));
 if(kind==='imports')section.append(node('p','Only selected items are imported; your library is not synchronized every 15 minutes. Downloads, analysis, classification, and indexing are separate stages. Videos provide metadata only.','muted'),linkTo('Choose photos or reconnect','/settings/connections'));
 const list=node('ul','','history-list');list.id='history-entries';
 for(const item of items){const li=node('li','','history-entry');const title=node('div','','history-entry-heading');title.append(node('h3',kind==='imports'?'Photo import':`${(item as HistoryEntry).stage} · ${(item as HistoryEntry).entry_type}`),node('span',item.status,'badge '+(item.status==='failed'||item.status==='expired'?'bad':'')));li.append(title,node('p',accountName(item.account_id),'muted'),node('p',when(item.created_at),'muted'),node('code',item.id,'entry-id'));
 if(kind==='imports'){const photo=item as Import;li.append(node('p',Object.entries(photo.counts??{}).map(([k,v])=>`${k}: ${v}`).join(' · ')||'Waiting for your selection'));if(photo.embedding_model_configured===false)li.append(node('p','Embeddings are not configured. Download and keyword progress do not mean semantic search is ready.','attention'));li.append(node('p','Selection expires '+when(photo.expires_at),'muted'));}
 else {const job=item as HistoryEntry;if(job.stream_key)li.append(node('p',`Stream: ${job.stream_key} · Attempt ${job.attempt} of ${job.max_attempts}`,'muted'));if(job.entry_type==='job'&&job.status==='failed')li.append(button(`Retry ${job.stage} · ${job.id}`,async()=>{await api(`/api/operations/jobs/${job.id}/retry`,'POST',{});notice('Retry queued.');await renderScreen();}));}
 if(item.error_code)li.append(node('p','Error: '+item.error_code,'attention'));
 if(item.status==='expired')li.append(node('p','Expired selections require choosing photos again.','muted'),linkTo('Choose photos again','/settings/connections'));
 else if(item.status==='failed'&&(kind==='imports'||(item as HistoryEntry).entry_type==='import'))li.append(linkTo('Inspect failed processing jobs','/logs/jobs?'+new URLSearchParams({source:item.account_id,status:'failed'})));list.append(li);}
 if(!items.length)list.append(node('li','No matching entries. Try changing filters or return to newest.','empty'));
 section.append(list);el('content').append(section);paging(query,data.next_cursor);
}
async function renderScreen(){
 if(!csrf)return;const current=++epoch;clearInterval(refreshTimer);const {path}=screen();notice('');
 el('navigation').classList.remove('open');el('menu').setAttribute('aria-expanded','false');
 el('navigation').querySelectorAll('a').forEach(a=>{if(a.getAttribute('href')==='#'+path)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 const titles:Record<string,[string,string]>={'/overview':['Overview','Your data and pipeline at a glance.'],'/sources':['Sources','Coverage, polling, and event delivery for each source.'],'/logs/jobs':['Job History','Inspect pipeline work across every processing stage.'],'/logs/failures':['Failures','Investigate failed jobs and failed or expired imports.'],'/logs/imports':['Photo Imports','Follow selection, download, and processing progress.'],'/settings/connections':['Connections','Connect and authorize your data sources.'],'/settings/agents':['Agent Access','Manage read-only access for your agents.'],'/settings/conversations':['Personal Conversations','Manage explicit conversation relevance.']};
 heading(...titles[path]);const loading=node('p','Loading…','loading');el('content').append(loading);el('content').setAttribute('aria-busy','true');
 try{
 if(path==='/overview'||path==='/sources'){
  const div=node('div','','stack');div.id='overview';el('content').append(div);await overview(path==='/sources');
  if(path==='/overview'){let refreshing=false;refreshTimer=setInterval(()=>{if(refreshing)return;refreshing=true;void overview().catch(report).finally(()=>{refreshing=false;});},5000);}
 }else if(path.startsWith('/logs/'))await historyScreen(path.split('/').at(-1) as 'jobs'|'failures'|'imports');
 else if(path==='/settings/connections'){
  el('content').insertAdjacentHTML('beforeend','<section class="panel"><h2>Source connections</h2><p>Connect each source separately. Authorization is verified when you return from the provider.</p><div id="connect" class="flex flex-wrap gap-3 mt-5"></div><ul id="accounts" class="stack mt-6"></ul></section>');await connections();
 }else if(path==='/settings/agents')await agentSettings();else await conversations();
 }catch(error){if(current===epoch){report(error);el('content').append(node('p',errorText(error),'attention'),button('Try again',async()=>{await renderScreen();}));}}
 finally{if(current===epoch){loading.remove();el('content').setAttribute('aria-busy','false');}}
}
async function dashboard(){const data=await api<{accounts:Account[]}>('/api/connections');accountsCache=data.accounts;el('login').hidden=true;el('dashboard').hidden=false;el('logout').hidden=false;await renderScreen();}
window.addEventListener('hashchange',()=>{void renderScreen();});
el('menu').onclick=()=>{const open=el('navigation').classList.toggle('open');el('menu').setAttribute('aria-expanded',String(open));};
el<HTMLFormElement>('login-form').onsubmit=async event=>{
 event.preventDefault();const input=el<HTMLInputElement>('password'),password=input.value;input.value='';const submit=el('login-form').querySelector('button')!;submit.disabled=true;
 try{const result=await api<{csrf_token:string}>('/auth/login','POST',{password});csrf=result.csrf_token;await dashboard();}catch(error){report(error);}finally{submit.disabled=false;}
};
el('logout').onclick=async()=>{try{await api('/auth/logout','POST',{});showLogin();notice('Signed out.');}catch(error){report(error);}};
try{
 const setup=await api<{configured:boolean}>('/auth/setup');el('setup').hidden=setup.configured;
 if(!setup.configured)showLogin();else{try{const session=await api<{csrf_token:string}>('/auth/session');csrf=session.csrf_token;if(new URLSearchParams(location.search).get('connection')==='success'){history.replaceState(null,'',location.pathname+'#/settings/connections');}await dashboard();}catch{showLogin();}}
}catch{notice('API unavailable. Start the API service and reload this page.');}
