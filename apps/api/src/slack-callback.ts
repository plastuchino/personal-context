import {type IncomingMessage,type ServerResponse} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const callbackPath='/api/connections/slack/callback';
export function slackCallbackHandler(apiOrigin:string,dashboardOrigin:string,request:typeof fetch=fetch) {
 const api=new URL(apiOrigin),dashboard=new URL(dashboardOrigin);
 if(api.protocol!=='http:'||api.hostname!=='127.0.0.1'||api.pathname!=='/'||api.search||api.hash||api.username||api.password)throw new Error('Callback bridge requires the loopback API origin');
 if(!['http:','https:'].includes(dashboard.protocol)||dashboard.username||dashboard.password||dashboard.pathname!=='/'||dashboard.search||dashboard.hash)throw new Error('Invalid dashboard origin');
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end('GET only');return;}
  let path:URL;try{path=new URL(req.url??'/','https://127.0.0.1');}catch{res.writeHead(400);res.end('Invalid request');return;}
  if(path.pathname==='/'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('Local Slack OAuth callback is ready. Return to the dashboard to connect Slack.');return;}
  if(path.pathname!==callbackPath){res.writeHead(404);res.end('Not found');return;}
  try{
   const response=await request(new URL(path.pathname+path.search,api),{headers:{Accept:'text/html',...(req.headers.cookie?{Cookie:req.headers.cookie}:{})},redirect:'manual',signal:AbortSignal.timeout(30000)});
   const location=response.headers.get('Location');
   if(location&&new URL(location,api).origin!==dashboard.origin)throw new Error('Unexpected callback redirect');
   const body=await response.text();if(Buffer.byteLength(body)>16384)throw new Error('Unexpected callback response size');
   res.writeHead(response.status,{'Content-Type':response.headers.get('Content-Type')??'application/json',...(location?{Location:new URL(location,api).toString()}:{})});res.end(body);
  }catch{res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});res.end('Slack callback could not reach the API. Return to the dashboard and restart connection setup.');}
 };
}
if(process.argv[1]?.endsWith('/slack-callback.ts')){
 const callback=new URL(process.env.SLACK_REDIRECT_URI??'https://127.0.0.1:5443'+callbackPath);
 if(callback.protocol!=='https:'||callback.hostname!=='127.0.0.1'||callback.pathname!==callbackPath||callback.search||callback.hash||callback.username||callback.password)throw new Error('Local Slack callback must use the loopback HTTPS callback URL');
 const port=process.env.API_PORT??'3000';if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new Error('Invalid API_PORT');
 const api='http://127.0.0.1:'+port;
 let healthy=false;for(let attempt=0;attempt<20;attempt++){try{const health=await (await fetch(api+'/health',{signal:AbortSignal.timeout(1000)})).json() as {service?:string};healthy=health.service==='personal-context-api';}catch{}if(healthy)break;await delay(250);}
 if(!healthy)throw new Error('Start the personal-context API before the callback bridge');
 const server=createHttpsServer({key:await readFile('.local/slack-oauth/key.pem'),cert:await readFile('.local/slack-oauth/cert.pem'),minVersion:'TLSv1.2'},slackCallbackHandler(api,process.env.APP_ORIGIN??'http://127.0.0.1:5173'));
 server.listen(Number(callback.port||443),'127.0.0.1',()=>console.log('Local Slack OAuth HTTPS callback ready on '+callback.origin));
 for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>server.close());
}
