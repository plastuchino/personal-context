import type pg from 'pg';
import {credentialCipher} from '@personal-context/security';
import {transaction} from './records.js';
import type {PlaidCall,PlaidConfig} from '../../connectors/src/plaid.js';
export async function connectFinancialItem(pool:pg.Pool,call:PlaidCall,config:PlaidConfig,accessToken:string,key:string):Promise<string>{
 const item=await call('/item/get',{access_token:accessToken});
 if(item.item?.error||!item.item?.institution_id||!item.item?.item_id)throw new Error('Financial item unavailable');
 const institution=await call('/institutions/get_by_id',{institution_id:item.item.institution_id,country_codes:['US']});
 if(!/^capital\s*one\b/i.test(institution.institution?.name??''))throw new Error('Capital One connection required');
 const encrypted=credentialCipher(key).encrypt(JSON.stringify({access_token:accessToken,environment:config.environment}));
 return transaction(pool,async c=>{
  const id=(await c.query(`INSERT INTO source_accounts(provider,external_account_id,display_name,status,provider_environment) VALUES('capital-one',$1,$2,'active',$3)
   ON CONFLICT(provider,external_account_id) DO UPDATE SET status='active' RETURNING id`,[`${config.environment}:${item.item.item_id}`,`Capital One (${config.environment})`,config.environment])).rows[0].id;
  const ref=(await c.query('INSERT INTO encrypted_credentials(ciphertext) VALUES($1) RETURNING id',[encrypted])).rows[0].id;
  await c.query('UPDATE source_accounts SET credential_ref=$2 WHERE id=$1',[id,ref]);
  await c.query("INSERT INTO sync_state(account_id,stream_key) VALUES($1,'transactions') ON CONFLICT DO NOTHING",[id]);return id;
 });
}
