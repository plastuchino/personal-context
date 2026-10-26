import type {SourceRecord} from '../../database/src/records.js';
import {ProviderError} from './http.js';
export interface PickedMedia {id:string;createTime?:string;type:string;mediaFile:{baseUrl:string;mimeType:string;filename?:string;mediaFileMetadata?:{width?:number;height?:number;[key:string]:unknown}}}
export interface PickerSession {id:string;pickerUri:string;expireTime:string;mediaItemsSet?:boolean;pollingConfig?:{pollInterval?:string;timeoutIn?:string}}
export interface PhotoClient {
 create():Promise<PickerSession>; get(id:string):Promise<PickerSession>;
 list(id:string,page?:string):Promise<{mediaItems:PickedMedia[];nextPageToken?:string}>;
 download(url:string,mimeType:string,maxBytes:number):Promise<Buffer>;
}
export function durationMs(value:string|undefined,fallback:number):number {
 if(!value)return fallback;
 if(!/^\d+(?:\.\d+)?s$/.test(value))throw new Error('Invalid provider polling duration');
 return Math.max(1000,Math.ceil(Number(value.slice(0,-1))*1000));
}
function canonical(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
export function photoRecord(accountId:string,item:PickedMedia,sha256?:string):SourceRecord {
 const {baseUrl,...metadata}=item.mediaFile;
 const content={id:item.id,createTime:item.createTime??null,type:item.type,mediaFile:metadata,...(sha256?{sha256}:{})};
 const size=(n:unknown)=>typeof n==='number'&&Number.isInteger(n)&&n>0?n:null;
 return {accountId,externalId:item.id,kind:item.type==='VIDEO'?'video':'photo',sourceCreatedAt:item.createTime??null,
  title:item.mediaFile.filename??item.id,bodyText:JSON.stringify(canonical(content)),rawPayload:item,hashPayload:content,
  photo:{capturedAt:item.createTime??null,mimeType:item.mediaFile.mimeType,width:size(item.mediaFile.mediaFileMetadata?.width),height:size(item.mediaFile.mediaFileMetadata?.height),filename:item.mediaFile.filename??null}};
}
export async function boundedMedia(response:Response,maxBytes:number):Promise<Buffer>{
 if(!response.ok)throw new ProviderError(response.status===401||response.status===403?'photo_download_expired':'photo_download_failed',response.status);
 const declared=response.headers.get('Content-Length');
 if(declared&&Number(declared)>maxBytes){await response.body?.cancel();throw new ProviderError('media_too_large',413);}
 if(!response.body)throw new Error('Media response has no body');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new ProviderError('media_too_large',413);}chunks.push(next.value);}}finally{reader.releaseLock();}
 if(!bytes)throw new Error('Empty media response');return Buffer.concat(chunks);
}
export function photoClient(accessToken:()=>Promise<string>,request:typeof fetch=fetch):PhotoClient {
 async function call(path:string,method='GET'){
  const response=await request('https://photospicker.googleapis.com/v1'+path,{method,headers:{Authorization:'Bearer '+await accessToken(),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new ProviderError(response.status===404||response.status===410?'photo_selection_expired':response.status===401?'reauthorize':'photo_provider_error',response.status);
  return response.json();
 }
 return {create:()=>call('/sessions','POST'),get:id=>call('/sessions/'+encodeURIComponent(id)),list:(id,page)=>call('/mediaItems?'+new URLSearchParams({sessionId:id,pageSize:'100',...(page?{pageToken:page}:{})})),
  async download(base,mime,max){
   let url=new URL(base+(mime.startsWith('video/')?'=dv':'=d'));
   for(let redirect=0;redirect<4;redirect++){
    if(url.protocol!=='https:'||!(url.hostname==='googleusercontent.com'||url.hostname.endsWith('.googleusercontent.com')))throw new Error('Untrusted photo download host');
    const response=await request(url,{headers:{Authorization:'Bearer '+await accessToken()},redirect:'manual',signal:AbortSignal.timeout(30000)});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('Location');await response.body?.cancel();if(!location)throw new Error('Missing media redirect');url=new URL(location,url);continue;}
    return boundedMedia(response,max);
   }throw new Error('Too many media redirects');
  }};
}
