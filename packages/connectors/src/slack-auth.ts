import type pg from 'pg';
import { credentialCipher } from '@personal-context/security';
import { transaction } from '../../database/src/records.js';
import { providerGet, ProviderError, type ProviderGet } from './http.js';

export async function slackAuthorizedGet(pool:pg.Pool,accountId:string,key:string,clientId?:string,clientSecret?:string,request:typeof fetch=fetch):Promise<ProviderGet> {
 const cipher=credentialCipher(key);
 let rejected=false;
 const access=await transaction(pool,async c=>{
  const row=(await c.query(`SELECT a.credential_ref,e.ciphertext FROM source_accounts a JOIN encrypted_credentials e ON e.id=a.credential_ref WHERE a.id=$1 AND a.provider='slack' AND a.status='active' FOR UPDATE OF a`,[accountId])).rows[0];
  if(!row)throw new ProviderError('reauthorize',401);
  let data=JSON.parse(cipher.decrypt(row.ciphertext));
  if(data.expires_in && Date.parse(data.obtained_at)+Number(data.expires_in)*1000<Date.now()+60000){
   if(!data.refresh_token||!clientId||!clientSecret)rejected=true;
   else{
    const response=await request('https://slack.com/api/oauth.v2.access',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:data.refresh_token,client_id:clientId,client_secret:clientSecret}),signal:AbortSignal.timeout(20000)});
    const result=response.ok?await response.json() as any:null;
    if(!result?.ok||!result.access_token)rejected=true;
    else{
     data={...data,...result,obtained_at:new Date().toISOString()};
     const id=(await c.query('INSERT INTO encrypted_credentials(ciphertext) VALUES($1) RETURNING id',[cipher.encrypt(JSON.stringify(data))])).rows[0].id;
     await c.query('UPDATE source_accounts SET credential_ref=$2 WHERE id=$1',[accountId,id]);
    }
   }
  }
  if(rejected){await c.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[accountId]);return null;}
  return data.access_token as string;
 });
 if(!access)throw new ProviderError('reauthorize',401);
 const get=providerGet('https://slack.com/api',access,request);
 return async(path,params)=>{
  try{return await get(path,params);}
  catch(error){if(error instanceof ProviderError&&error.status===401)await pool.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[accountId]);throw error;}
 };
}
