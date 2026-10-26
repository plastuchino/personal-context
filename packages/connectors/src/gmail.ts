import type { SourceRecord } from '../../database/src/records.js';
import { ProviderError,type ProviderGet } from './http.js';
export interface GmailCursor {phase:'backfill'|'history';anchor:string;pageToken?:string;since:number;selfEmail:string}
export interface ConnectorPage {records:SourceRecord[];cursor:unknown;complete:boolean;watermark?:string;coverageStart?:string;coverageComplete?:boolean;reset?:boolean}
function headers(message:any):Record<string,string>{return Object.fromEntries((message.payload?.headers??[]).map((h:any)=>[String(h.name).toLowerCase(),String(h.value)]));}
function body(part:any):string {
 const parts=part?.parts??[];const plain=parts.filter((p:any)=>p.mimeType==='text/plain');
 if(plain.length)return plain.map(body).join('\n');
 if(parts.length)return parts.map(body).join('\n');
 return part?.body?.data?Buffer.from(part.body.data,'base64url').toString('utf8'):'';
}
function addresses(value:string):string[]{return [...new Set(value.match(/[^\s<>,;]+@[^\s<>,;]+/g)??[])];}
export function gmailRecord(accountId:string,message:any,selfEmail:string):SourceRecord {
 const h=headers(message);const date=message.internalDate?new Date(Number(message.internalDate)).toISOString():null;
 return {accountId,externalId:message.id,kind:'email',sourceUrl:`https://mail.google.com/mail/u/${encodeURIComponent(selfEmail)}/#all/${message.id}`,sourceCreatedAt:date,
  title:h.subject??'',bodyText:body(message.payload)||message.snippet||'',rawPayload:message,
  conversation:{externalId:message.threadId,kind:'email-thread',title:h.subject??''},
  participants:['from','to','cc','bcc'].flatMap(role=>addresses(h[role]??'').map(email=>({externalId:email.toLowerCase(),email,role:role==='from'?'sender':'recipient',isSelf:email.toLowerCase()===selfEmail.toLowerCase()}))),
  email:{messageIdHeader:h['message-id']??null,inReplyTo:h['in-reply-to']??null,labels:message.labelIds??[]}};
}
export async function gmailPage(get:ProviderGet,accountId:string,cursor:GmailCursor|null,backfillDays:number,now=new Date()):Promise<ConnectorPage> {
 let state=cursor;
 if(!state){const profile=await get('/profile');state={phase:'backfill',anchor:profile.historyId,since:Math.floor(now.getTime()/1000)-backfillDays*86400,selfEmail:profile.emailAddress};}
 const records:SourceRecord[]=[];
 const fetchMessage=async(id:string)=>{
  try{records.push(gmailRecord(accountId,await get(`/messages/${encodeURIComponent(id)}`,{format:'full'}),state!.selfEmail));}
  catch(error){if(error instanceof ProviderError&&error.status===404)records.push({accountId,externalId:id,kind:'email',bodyText:'',rawPayload:{id},deleted:true});else throw error;}
 };
 if(state.phase==='backfill'){
  const data=await get('/messages',{q:`after:${state.since}`,maxResults:'100',pageToken:state.pageToken,includeSpamTrash:'true'});
  for(const item of data.messages??[])await fetchMessage(item.id);
  const complete=!data.nextPageToken;
  return {records,cursor:{...state,phase:complete?'history':'backfill',pageToken:data.nextPageToken},complete,coverageStart:new Date(state.since*1000).toISOString(),coverageComplete:complete};
 }
 let data:any;
 try{data=await get('/history',{startHistoryId:state.anchor,maxResults:'100',pageToken:state.pageToken});}
 catch(error){if(error instanceof ProviderError&&error.status===404)return {records:[],cursor:null,complete:false,reset:true};throw error;}
 const changed=new Set<string>(),deleted=new Set<string>();
 for(const h of data.history??[]){
  for(const kind of ['messagesAdded','labelsAdded','labelsRemoved'])for(const item of h[kind]??[])changed.add(item.message.id);
  for(const item of h.messagesDeleted??[])deleted.add(item.message.id);
 }
 for(const id of changed)if(!deleted.has(id))await fetchMessage(id);
 for(const id of deleted)records.push({accountId,externalId:id,kind:'email',bodyText:'',rawPayload:{id},deleted:true});
 return {records,cursor:{...state,anchor:data.nextPageToken?state.anchor:data.historyId,pageToken:data.nextPageToken},complete:!data.nextPageToken};
}
