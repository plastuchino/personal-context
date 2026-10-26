import {createHash} from 'node:crypto';
import {labels,providers} from '@personal-context/contracts';
export const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface SearchFilters {account_id?:string;provider?:string;kind?:string;external_id?:string;conversation_id?:string;participant?:string;label?:string;task_status?:string;from?:string;to?:string;amount?:string;currency?:string;merchant?:string;financial_account_id?:string;pending?:boolean;posted_date?:string;calendar_date?:string;calendar_start?:string}
export interface SearchInput {query?:string;filters?:SearchFilters;limit?:number;cursor?:string}
export function validateSearch(input:unknown):SearchInput {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid search');
 const value=input as SearchInput;const allowed=['query','filters','limit','cursor'];if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('Unknown search field');
 if(value.query!==undefined&&(typeof value.query!=='string'||value.query.length>2000))throw new Error('Query is too long');
 if(value.limit!==undefined&&(!Number.isInteger(value.limit)||value.limit<1||value.limit>50))throw new Error('Limit must be 1–50');
 if(value.cursor!==undefined&&(typeof value.cursor!=='string'||value.cursor.length>300))throw new Error('Invalid cursor');
 const f=value.filters??{};if(typeof f!=='object'||!f||Array.isArray(f))throw new Error('Invalid filters');
 const keys=['account_id','provider','kind','external_id','conversation_id','participant','label','task_status','from','to','amount','currency','merchant','financial_account_id','pending','posted_date','calendar_date','calendar_start'];
 if(Object.keys(f).some(k=>!keys.includes(k)))throw new Error('Unknown filter');
 for(const [key,item]of Object.entries(f))if(key!=='pending'&&(typeof item!=='string'||!item.length||item.length>500))throw new Error('Invalid filter');
 for(const key of ['account_id','conversation_id','financial_account_id']as const)if(f[key]&&!uuid.test(f[key]!))throw new Error('Invalid identifier');
 if(f.provider&&!providers.includes(f.provider as typeof providers[number]))throw new Error('Invalid provider');
 if(f.label&&!labels.includes(f.label as typeof labels[number]))throw new Error('Invalid label');
 if(f.task_status&&!['open','done','uncertain'].includes(f.task_status))throw new Error('Invalid task status');
 if(f.pending!==undefined&&typeof f.pending!=='boolean')throw new Error('Invalid pending filter');
 if(f.amount&&!/^-?\d{1,60}(?:\.\d{1,30})?$/.test(f.amount))throw new Error('Amount must be an exact decimal string');
 if(f.currency&&!/^[A-Z]{3}$/.test(f.currency))throw new Error('Invalid currency');
 for(const key of ['from','to','calendar_start']as const)if(f[key]&&(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(f[key]!)||!Number.isFinite(Date.parse(f[key]!))))throw new Error('Dates require a timezone');
 for(const key of ['posted_date','calendar_date']as const)if(f[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(f[key]!)||new Date(f[key]!).toISOString().slice(0,10)!==f[key]))throw new Error('Invalid calendar date');
 return value;
}
export function queryFingerprint(input:SearchInput):string {return createHash('sha256').update(JSON.stringify({query:input.query??'',filters:Object.fromEntries(Object.entries(input.filters??{}).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex').slice(0,24);}
