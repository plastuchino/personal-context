import { Hono } from 'hono';
import type pg from 'pg';
import type { OwnerEnv } from './owner.js';
import { createOAuthState,consumeOAuthState,storeCredential } from '../../../packages/database/src/credentials.js';
import { credentialCipher } from '@personal-context/security';

const scopes = {
 gmail: ['openid','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/gmail.readonly'],
 calendar: ['openid','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/calendar.readonly'],
 'google-photos': ['openid','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/photospicker.mediaitems.readonly'],
 slack: ['channels:history','channels:read','groups:history','groups:read','im:history','im:read','mpim:history','mpim:read','users:read'],
};
type OAuthProvider=keyof typeof scopes;
export interface OAuthConfig { googleClientId?:string;googleClientSecret?:string;slackClientId?:string;slackClientSecret?:string;slackAppId?:string;slackRedirectUri?:string;encryptionKey?:string }
export function oauthRoutes(pool:pg.Pool,origin:string,config:OAuthConfig,request:typeof fetch=fetch) {
 const routes=new Hono<OwnerEnv>();
 if(config.slackRedirectUri){const callback=new URL(config.slackRedirectUri);if(callback.protocol!=='https:'||callback.hostname!==new URL(origin).hostname||callback.pathname!=='/api/connections/slack/callback'||callback.username||callback.password||callback.search||callback.hash)throw new Error('SLACK_REDIRECT_URI must be the HTTPS Slack callback on the dashboard host');}
 function settings(provider:OAuthProvider) {
  const id=provider==='slack'?config.slackClientId:config.googleClientId;
  const secret=provider==='slack'?config.slackClientSecret:config.googleClientSecret;
  if(!id||!secret||!config.encryptionKey||(provider==='slack'&&!config.slackAppId)) return null;
  credentialCipher(config.encryptionKey);
  const redirect=provider==='slack'?(config.slackRedirectUri??`${origin}/api/connections/slack/callback`):`${origin}/api/connections/${provider}/callback`;
  if(provider==='slack'&&new URL(redirect).protocol!=='https:')return null;
  return {id,secret,redirect};
 }
 routes.post('/:provider/start',async c=>{
  const provider=c.req.param('provider');
  if(!Object.hasOwn(scopes,provider)) return c.json({error:'Unsupported OAuth provider'},400);
  const p=provider as OAuthProvider;const setup=settings(p);
  if(!setup)return c.json({error:'Provider OAuth is not configured'},503);
  const state=await createOAuthState(pool,c.get('ownerSession'),p);
  const url=new URL(p==='slack'?'https://slack.com/oauth/v2/authorize':'https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',setup.id);url.searchParams.set('redirect_uri',setup.redirect);url.searchParams.set('state',state);
  if(p==='slack')url.searchParams.set('user_scope',scopes.slack.join(','));
  else {url.searchParams.set('response_type','code');url.searchParams.set('scope',scopes[p].join(' '));url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');}
  c.header('Cache-Control','no-store');return c.json({authorization_url:url.toString()});
 });
 routes.get('/:provider/callback',async c=>{
  const provider=c.req.param('provider');
  if(!Object.hasOwn(scopes,provider)) return c.json({error:'Unsupported OAuth provider'},400);
  const p=provider as OAuthProvider;const setup=settings(p);
  if(!setup)return c.json({error:'Provider OAuth is not configured'},503);
  try {await consumeOAuthState(pool,c.req.query('state')??'',c.get('ownerSession'),p);}
  catch{return c.json({error:'Invalid or expired authorization session'},400);}
  if(c.req.query('error')||!c.req.query('code'))return c.json({error:'Authorization was not completed; restart connection setup'},400);
  let accountId:string|undefined;
  try {
   const form=new URLSearchParams({client_id:setup.id,client_secret:setup.secret,code:c.req.query('code')!,redirect_uri:setup.redirect});
   if(p!=='slack')form.set('grant_type','authorization_code');
   const response=await request(p==='slack'?'https://slack.com/api/oauth.v2.access':'https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});
   if(!response.ok) throw new Error('Token exchange failed');
   const data=await response.json() as Record<string,any>;
   if(p==='slack'&&!data.ok)throw new Error('Token exchange failed');
   const credentials=p==='slack'?data.authed_user:data;
   if(!credentials?.access_token)throw new Error('No user access token');
   const granted=new Set(String(credentials.scope??data.scope??'').split(/[ ,]+/));
   if(scopes[p].some(scope=>!granted.has(scope)))throw new Error('Required scope not granted');
   let externalId:string,display:string;
   if(p==='slack') {
    if(!data.team?.id||!data.authed_user?.id)throw new Error('Missing Slack identity');
    externalId=`${data.team.id}:${data.authed_user.id}`;display=data.team.name??externalId;
   } else {
    // Tokeninfo validates the access token's subject without adding unrelated profile scopes.
    const identity=await request(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(credentials.access_token)}`,{signal:AbortSignal.timeout(20000)});
    if(!identity.ok)throw new Error('Identity lookup failed');
    const info=await identity.json() as Record<string,any>;
    if(info.aud!==setup.id||!info.sub)throw new Error('Unexpected token identity');
    externalId=info.sub;display=info.email??`${p} account`;
    if(!credentials.refresh_token)throw new Error('Offline authorization required');
   }
   accountId=(await pool.query(`INSERT INTO source_accounts(provider,external_account_id,display_name,status) VALUES($1,$2,$3,'disabled')
    ON CONFLICT(provider,external_account_id) DO UPDATE SET status='disabled' RETURNING id`,[p,externalId,display])).rows[0].id;
   if(p==='slack')await pool.query(`INSERT INTO slack_connection_state(account_id,app_id,team_id,authorized_user_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET app_id=excluded.app_id,team_id=excluded.team_id,authorized_user_id=excluded.authorized_user_id`,[accountId,config.slackAppId,data.team.id,data.authed_user.id]);
   await storeCredential(pool,accountId!,JSON.stringify({...credentials,obtained_at:new Date().toISOString()}),config.encryptionKey!);
   await pool.query("UPDATE source_accounts SET status='active' WHERE id=$1",[accountId]);
   // Connector-specific discovery creates stream rows; connection success alone is not coverage.
   c.header('Cache-Control','no-store');
   if(c.req.header('Accept')?.includes('text/html'))return c.redirect(`${origin}/?connection=success`,303);
   return c.json({connected:true,account_id:accountId});
  } catch {
   if(accountId)await pool.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[accountId]);
   return c.json({error:'Connection failed; retry authorization and check provider configuration'},502);
  }
 });
 return routes;
}
