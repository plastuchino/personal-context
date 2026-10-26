import {historyFilter,historyPage} from '../../../packages/database/src/operations-history.js';
import {photoStatus} from '../../../packages/database/src/photo-status.js';
import {mcpRoutes,type RetrievalConfig} from './mcp.js';
import { operations } from './operations.js';
import { createPhotoImport } from '../../../packages/database/src/photo-imports.js';
import { photoClient } from '../../../packages/connectors/src/photos.js';
import { googleAccessToken } from '../../../packages/connectors/src/google-auth.js';
import { configureSlackSocket } from '../../../packages/database/src/slack-connection.js';
import { oauthRoutes,type OAuthConfig } from './oauth.js';
import { issueAgent, revokeAgent } from '../../../packages/database/src/agents.js';
import { bodyLimit } from 'hono/body-limit';
import { ownerAccess } from './owner.js';
import type pg from 'pg';
import { Hono } from 'hono';
import type { HealthResponse } from '@personal-context/contracts';

export const app = new Hono();
// Liveness contains no personal data. Protected operational routes are added separately.
app.get('/health', (c) => c.json({ service: 'personal-context-api', status: 'ok' } satisfies HealthResponse));
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export function createApp(pool:pg.Pool,origin:string,oauth:OAuthConfig={},request:typeof fetch=fetch,retrieval:RetrievalConfig={models:{embed:async()=>{throw new Error('Embedding model unconfigured');}},embedding:null}) {
 const server=new Hono();
 const owner=ownerAccess(pool,origin);
 server.use('*',bodyLimit({maxSize:16384,onError:c=>c.json({error:'Request too large'},413)}));
 server.route('/auth',owner.routes);
 server.route('/mcp',mcpRoutes(pool,origin,retrieval));
 server.use('/api/*',owner.requireOwner);
 server.post('/api/agents',async c=>{
  let input:unknown;try{input=await c.req.json();}catch{return c.json({error:'Invalid request'},400);}
  if(!input||typeof input!=='object'||!('name'in input)||typeof input.name!=='string'||!('accounts'in input)||!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>100||!input.accounts.every(x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x)))return c.json({error:'Invalid agent or source grants'},400);
  const agent=await issueAgent(pool,input.name,input.accounts);
  c.header('Cache-Control','no-store');return c.json(agent,201);
 });
 server.delete('/api/agents/:id',async c=>{
  if(!/^[a-f0-9-]{36}$/i.test(c.req.param('id')))return c.json({error:'Invalid identifier'},400);
  await revokeAgent(pool,c.req.param('id'));return c.json({ok:true});
 });
 server.post('/api/connections/slack/:id/socket-token',async c=>{
  if(!oauth.encryptionKey)return c.json({error:'Credential encryption is not configured'},503);
  if(!/^[a-f0-9-]{36}$/i.test(c.req.param('id')))return c.json({error:'Invalid identifier'},400);
  let input:unknown;try{input=await c.req.json();}catch{return c.json({error:'Invalid request'},400);}
  if(!input||typeof input!=='object'||!('app_token'in input)||typeof input.app_token!=='string'||!/^xapp-[A-Za-z0-9-]+$/.test(input.app_token)||input.app_token.length>2048)return c.json({error:'Invalid app token'},400);
  const configured=await configureSlackSocket(pool,c.req.param('id'),input.app_token,oauth.encryptionKey);
  c.header('Cache-Control','no-store');return configured?c.json({configured:true}):c.json({error:'Slack installation not found'},404);
 });
 server.route('/api/operations',operations(pool));
 server.route('/api/connections',oauthRoutes(pool,origin,oauth,request));
 server.post('/api/photos/:id/sessions',async c=>{
  if(!oauth.encryptionKey)return c.json({error:'Google Photos credentials are not configured'},503);
  const id=c.req.param('id');if(!/^[a-f0-9-]{36}$/i.test(id))return c.json({error:'Invalid identifier'},400);
  const client=photoClient(()=>googleAccessToken(pool,id,oauth.encryptionKey!,oauth.googleClientId,oauth.googleClientSecret,request),request);
  c.header('Cache-Control','no-store');return c.json(await createPhotoImport(pool,id,client),201);
 });
 server.get('/api/photos/sessions/:id',async c=>{
  const id=c.req.param('id');if(!/^[a-f0-9-]{36}$/i.test(id))return c.json({error:'Invalid identifier'},400);
  const row=(await photoStatus(pool,retrieval.embedding,id))[0];
  return row?c.json(row):c.json({error:'Import not found'},404);
 });
 server.get('/api/connections',async c=>{
  c.header('Cache-Control','no-store');
  const accounts=(await pool.query('SELECT id,provider,display_name,status,provider_environment FROM source_accounts ORDER BY provider,display_name')).rows;
  const missing=(entries:[string,string|undefined][])=>entries.filter(([,value])=>!value).map(([key])=>key);
  const setup_required={google:missing([['GOOGLE_CLIENT_ID',oauth.googleClientId],['GOOGLE_CLIENT_SECRET',oauth.googleClientSecret],['CREDENTIAL_ENCRYPTION_KEY',oauth.encryptionKey]]),slack:missing([['SLACK_CLIENT_ID',oauth.slackClientId],['SLACK_CLIENT_SECRET',oauth.slackClientSecret],['SLACK_APP_ID',oauth.slackAppId],['CREDENTIAL_ENCRYPTION_KEY',oauth.encryptionKey]])};
  if(new URL(origin).protocol!=='https:'&&!oauth.slackRedirectUri)setup_required.slack.push('SLACK_REDIRECT_URI');
  return c.json({accounts,configured:{google:setup_required.google.length===0,slack:setup_required.slack.length===0},setup_required});
 });
 server.get('/api/photos/imports',async c=>{
  c.header('Cache-Control','no-store');
  let filter;try{filter=historyFilter(c.req.query(),'imports');}catch{return c.json({error:'Invalid history filters or cursor'},400);}
  const page=await historyPage(pool,'imports',filter);
  return c.json({imports:await photoStatus(pool,retrieval.embedding,undefined,page.items.map(x=>x.id)),next_cursor:page.next_cursor});
 });
 server.get('/api/session',c=>c.json({authenticated:true}));
 server.route('/',app);
 server.onError((_error,c)=>c.json({error:'Internal service error'},500));
 return server;
}
