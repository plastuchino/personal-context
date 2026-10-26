import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type pg from 'pg';
import { digest, token, verifyPassword } from '@personal-context/security';
import { transaction } from '../../../packages/database/src/records.js';

export type OwnerEnv = { Variables: { ownerSession: string } };
export function ownerAccess(pool:pg.Pool,origin:string) {
 const url=new URL(origin);
 if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('APP_ORIGIN must use HTTPS except on loopback');
 if(url.origin!==origin) throw new Error('APP_ORIGIN must be an origin without a path');
 const cookieName=url.protocol==='https:'?'__Host-owner_session':'owner_session';
 const cookieOptions={ httpOnly:true,secure:url.protocol==='https:',sameSite:'Lax' as const,path:'/' };
 const requireOwner:MiddlewareHandler<OwnerEnv>=async(c,next)=>{
  const raw=getCookie(c,cookieName);
  if(!raw) return c.json({error:'Unauthorized'},401);
  const session=(await pool.query('SELECT token_digest,csrf_digest FROM owner_sessions WHERE token_digest=$1 AND expires_at>now()',[digest(raw)])).rows[0];
  if(!session) return c.json({error:'Unauthorized'},401);
  if(!['GET','HEAD','OPTIONS'].includes(c.req.method) && (c.req.header('Origin')!==origin || digest(c.req.header('X-CSRF-Token') ?? '')!==session.csrf_digest)) return c.json({error:'Forbidden'},403);
  c.set('ownerSession',session.token_digest);await next();
 };
 const routes=new Hono<OwnerEnv>();
 routes.get('/setup',async c=>{
  c.header('Cache-Control','no-store');
  return c.json({configured:Boolean((await pool.query('SELECT 1 FROM owner_account WHERE id=true')).rowCount)});
 });
 routes.post('/login',async c=>{
  if(c.req.header('Origin')!==origin) return c.json({error:'Forbidden'},403);
  let body:unknown;
  try { body=await c.req.json(); } catch { return c.json({error:'Invalid request'},400); }
  if(!body||typeof body!=='object'||!('password' in body)||typeof body.password!=='string'||body.password.length>1024) return c.json({error:'Invalid credentials'},401);
  const allowed=await transaction(pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(8463902)');
   await db.query("DELETE FROM login_attempts WHERE occurred_at<now()-interval '15 minutes'");
   const n=(await db.query('SELECT count(*)::int AS n FROM login_attempts')).rows[0].n;
   if(n>=10)return false;
   await db.query('INSERT INTO login_attempts DEFAULT VALUES');return true;
  });
  if(!allowed)return c.json({error:'Too many login attempts'},429);
  const owner=(await pool.query('SELECT password_hash FROM owner_account WHERE id=true')).rows[0];
  if(!owner||!await verifyPassword(body.password,owner.password_hash)) return c.json({error:'Invalid credentials'},401);
  const secret=token(),csrf=token();
  await pool.query("INSERT INTO owner_sessions(token_digest,csrf_digest,expires_at) VALUES($1,$2,now()+interval '12 hours')",[digest(secret),digest(csrf)]);
  setCookie(c,cookieName,secret,{...cookieOptions,maxAge:43200});
  c.header('Cache-Control','no-store');return c.json({csrf_token:csrf});
 });
 routes.get('/session',requireOwner,async c=>{
  // Rotate CSRF secret so a page reload can establish an authenticated session.
  const csrf=token();await pool.query('UPDATE owner_sessions SET csrf_digest=$2 WHERE token_digest=$1',[c.get('ownerSession'),digest(csrf)]);
  c.header('Cache-Control','no-store');return c.json({csrf_token:csrf});
 });
 routes.post('/logout',requireOwner,async c=>{
  await pool.query('DELETE FROM owner_sessions WHERE token_digest=$1',[c.get('ownerSession')]);
  deleteCookie(c,cookieName,cookieOptions);return c.json({ok:true});
 });
 return { routes,requireOwner };
}
