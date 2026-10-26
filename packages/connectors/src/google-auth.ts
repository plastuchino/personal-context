import type pg from 'pg';
import {credentialCipher} from '@personal-context/security';
import {transaction} from '../../database/src/records.js';
import {providerGet,ProviderError,type ProviderGet} from './http.js';
export async function googleAccessToken(pool:pg.Pool,accountId:string,key:string,clientId?:string,clientSecret?:string,request:typeof fetch=fetch):Promise<string>{
 const cipher=credentialCipher(key);
 const access=await transaction(pool,async c=>{
  const row=(await c.query(`SELECT e.ciphertext FROM source_accounts a JOIN encrypted_credentials e ON e.id=a.credential_ref WHERE a.id=$1 AND a.status='active' FOR UPDATE OF a`,[accountId])).rows[0];
  if(!row)throw new ProviderError('reauthorize',401);
  let data=JSON.parse(cipher.decrypt(row.ciphertext));
  if(!data.obtained_at||!data.expires_in||Date.parse(data.obtained_at)+Number(data.expires_in)*1000<Date.now()+60000){
   if(!data.refresh_token||!clientId||!clientSecret){await c.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[accountId]);return null;}
   const response=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:data.refresh_token,client_id:clientId,client_secret:clientSecret}),signal:AbortSignal.timeout(20000)});
   if(response.status===400||response.status===401){await c.query("UPDATE source_accounts SET status='reauthorize' WHERE id=$1",[accountId]);return null;}
   if(!response.ok)throw new ProviderError('provider_error',response.status);
   const fresh=await response.json() as any;if(!fresh.access_token)throw new Error('Invalid token response');
   data={...data,...fresh,obtained_at:new Date().toISOString()};
   const id=(await c.query('INSERT INTO encrypted_credentials(ciphertext) VALUES($1) RETURNING id',[cipher.encrypt(JSON.stringify(data))])).rows[0].id;
   await c.query('UPDATE source_accounts SET credential_ref=$2 WHERE id=$1',[accountId,id]);
  }
  return data.access_token as string;
 });
 if(!access)throw new ProviderError('reauthorize',401);
 return access;
}

export async function googleAuthorizedGet(pool:pg.Pool,accountId:string,base:string,key:string,clientId?:string,clientSecret?:string,request:typeof fetch=fetch):Promise<ProviderGet>{
 return providerGet(base,await googleAccessToken(pool,accountId,key,clientId,clientSecret,request),request);
}
